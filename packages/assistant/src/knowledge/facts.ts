import {
  canonicalizeFactKey,
  clamp01,
  memorySourceSchema,
  toDisplayText,
  type MemorySource,
} from "@alfred/contracts";
import { parseMemorySourceOrDefault } from "@alfred/assistant/settings";
import { createExecuteRowSchema, db, rowsFromExecute, type DbTransaction } from "@alfred/db";
import {
  rejectedInferences,
  userFactInsertSchema,
  userFacts,
  type NewUserFact,
  type UserFact,
} from "@alfred/db/schemas";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { publishEvent } from "@alfred/assistant/triggers";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import {
  classifyDocumentFactKey,
  isSingleValuedKey,
  isUninformativeRelationshipFact,
  validateFactValueForKey,
} from "./fact-policy";
import { valueSignature } from "./signature";
import { logger } from "@alfred/logging";

/** `user_facts.status` values (ADR-0019). The union derives from the tuple. */
export const FACT_STATUSES = ["proposed", "confirmed", "rejected", "edited", "superseded"] as const;

export const factStatusSchema = z.enum(FACT_STATUSES);

export type FactStatus = (typeof FACT_STATUSES)[number];

/** At or above this, a proposal auto-confirms; below, it waits for the user (ADR-0019). */
export const AUTO_CONFIRM_THRESHOLD = 0.85;

// --- schemas ---

export const proposeFactArgsSchema = userFactInsertSchema
  .pick({
    userId: true,
    key: true,
    value: true,
    confidence: true,
    source: true,
    validFrom: true,
    validUntil: true,
  })
  .extend({
    userId: z.string().min(1),
    key: z.string().min(1).max(200),
    // `proposeFact` runs the per-key policy check.
    value: z.unknown(),
    /** Clamped to [0, 1]: model confidences have no enforced range, and 1.1 would crash the gate. */
    confidence: z.number().transform(clamp01),
    source: memorySourceSchema,
  }) satisfies z.ZodType<
  Pick<
    NewUserFact,
    "userId" | "key" | "value" | "confidence" | "source" | "validFrom" | "validUntil"
  >
>;

export type ProposeFactArgs = z.infer<typeof proposeFactArgsSchema>;

const createFactArgsSchema = z.object({
  /** A Replicache client mints it, so the optimistic row and the server row share one key. */
  id: z.string().min(1),
  userId: z.string().min(1),
  key: z.string().min(1).max(200),
  value: z.unknown(),
  /** Defaults to `{ kind: 'user' }`. */
  source: memorySourceSchema.optional(),
});

type CreateFactArgs = z.infer<typeof createFactArgsSchema>;

const editFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** The id of the replacement row. A Replicache client mints it; absent, the server does. */
  newFactId: z.string().min(1).optional(),
  /** Defaults to `{ kind: 'user' }`. */
  source: memorySourceSchema.optional(),
});

export type EditFactArgs = z.infer<typeof editFactArgsSchema>;

const supersedeFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** Clamped like `proposeFactArgsSchema.confidence`. */
  confidence: z.number().transform(clamp01),
  source: memorySourceSchema,
});

export type SupersedeFactArgs = z.infer<typeof supersedeFactArgsSchema>;

const rejectFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  reason: z.unknown().optional(),
});

export type RejectFactArgs = z.infer<typeof rejectFactArgsSchema>;

// --- row shape ---

/** `UserFact` with the zod-parsed `status` and `source` narrowed. */
export type FactRow = Omit<UserFact, "status" | "source"> & {
  status: FactStatus;
  source: MemorySource;
};

/** INSERT…RETURNING gives `T | undefined`. */
function requireRow<T>(row: T | undefined, op: string): T {
  if (row == null) throw new Error(`[memory.facts] ${op} returned no row`);

  return row;
}

function rowToFact(r: UserFact): FactRow {
  return {
    ...r,
    status: factStatusSchema.parse(r.status),
    source: parseMemorySourceOrDefault(r.source, { kind: "agent" }, `user_facts:${r.id}`),
  };
}

// --- shared write steps ---

/**
 * A caller that already holds a transaction passes it as `exec` (a Replicache push passes its
 * savepoint `tx`). The write then commits or rolls back with it, and the caller pokes.
 */
type FactExec = { exec?: DbTransaction };

/** Serialize writes per `(userId, canonical key)`, or two writers can both add a confirmed single-valued row. */
async function lockFactKey(tx: DbTransaction, userId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
}

/** The canonical key. An alias moves into `source.meta.originalKey`; an unknown key stays as is. */
function canonicalKeyAndSource(rawKey: string, source: MemorySource) {
  const canon = canonicalizeFactKey(rawKey);

  if (!canon.ok) return { known: false, key: rawKey, source };

  return {
    known: true,
    key: canon.key,
    source: canon.wasAlias
      ? { ...source, meta: { ...source.meta, originalKey: canon.originalKey } }
      : source,
  };
}

/** `proposed` and `confirmed` rows for `(userId, key)` inside their validity window, newest first. */
async function activeFactsForKey(
  tx: DbTransaction,
  userId: string,
  key: string,
): Promise<UserFact[]> {
  return tx
    .select()
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, userId),
        eq(userFacts.key, key),
        inArray(userFacts.status, ["proposed", "confirmed"]),
        lte(userFacts.validFrom, sql`now()`),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
      ),
    )
    .orderBy(desc(userFacts.validFrom))
    .limit(50);
}

/** The confirmed rows of a single-valued key that hold a value other than `sig`. */
function confirmedConflicts(
  active: readonly UserFact[],
  key: string,
  sig: string,
  excludeId?: string,
): UserFact[] {
  if (!isSingleValuedKey(key)) return [];

  return active.filter(
    (row) =>
      row.id !== excludeId && row.status === "confirmed" && valueSignature(row.value) !== sig,
  );
}

async function supersedeFacts(
  tx: DbTransaction,
  userId: string,
  ids: readonly string[],
  at: Date,
): Promise<void> {
  if (ids.length === 0) return;

  await tx
    .update(userFacts)
    .set({
      status: "superseded",
      validUntil: at,
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(and(eq(userFacts.userId, userId), inArray(userFacts.id, [...ids])));
}

/**
 * Run `body` on `exec` when the caller holds a transaction. Otherwise open one, and poke
 * Replicache after it commits, so the client pull sees the row. `null` means no write to show.
 */
async function inFactTransaction<T>(
  exec: DbTransaction | undefined,
  userId: string,
  body: (tx: DbTransaction) => Promise<T | null>,
): Promise<T | null> {
  if (exec) return body(exec);

  const result = await db().transaction(body);

  if (result !== null) emitReplicachePokes([userId]);

  return result;
}

// --- propose ---

/**
 * Insert a fact: confirmed at or above `AUTO_CONFIRM_THRESHOLD`, else proposed.
 * The unbypassable backstop of the capture gate (#330, ADR-0079), in order:
 *  0. Canonicalize the key. An unknown key is rejected only from documents;
 *     other sources keep it with a drift trace.
 *  0a. Drop relationship junk from any source (#492).
 *  1. Documents: reject `not_writable` keys and bad values. Authorship is the
 *     workflow gate's job.
 *  2. Skip a value the user already rejected.
 *  3. Skip an active duplicate.
 *  4. Single-valued conflict: a user value supersedes; an autonomous value is held
 *     as `proposed` with no event. Code cannot tell "the user moved" from a leaked
 *     contact value, so surface it instead of overwriting.
 */
export async function proposeFact(args: ProposeFactArgs): Promise<FactRow | null> {
  const parsed = proposeFactArgsSchema.parse(args);
  const isDocument = parsed.source.kind === "document";

  // (0) Canonicalize before any dedup or conflict check.
  const { known, key, source } = canonicalKeyAndSource(parsed.key, parsed.source);

  if (!known) {
    // Unknown key: reject from documents; keep from trusted sources with a drift trace.
    if (isDocument) return null;
    logger.warn(
      `[memory.facts] fact_key_unknown_non_document: persisting unknown key as-is ` +
        `(source=${parsed.source.kind}, key=${JSON.stringify(parsed.key)})`,
    );
  }

  // (0a) Relationship junk, from any source.
  if (known && isUninformativeRelationshipFact(key, parsed.value)) return null;

  // (1) Document write policy.
  if (isDocument && known) {
    if (classifyDocumentFactKey(key) === "not_writable") return null;

    if (!validateFactValueForKey(key, parsed.value).ok) return null;
  }

  const sig = valueSignature(parsed.value);

  const confidenceStatus: FactStatus =
    parsed.confidence >= AUTO_CONFIRM_THRESHOLD ? "confirmed" : "proposed";

  const userDriven = parsed.source.kind === "user";

  return inFactTransaction(undefined, parsed.userId, async (tx) => {
    await lockFactKey(tx, parsed.userId, key);

    // (2) Already rejected.
    const [rejectedHit] = await tx
      .select({ id: rejectedInferences.id })
      .from(rejectedInferences)
      .where(
        and(
          eq(rejectedInferences.userId, parsed.userId),
          eq(rejectedInferences.key, key),
          eq(rejectedInferences.valueSignature, sig),
        ),
      )
      .limit(1);

    if (rejectedHit) return null;

    // (3) Active duplicate.
    const active = await activeFactsForKey(tx, parsed.userId, key);

    if (active.some((r) => valueSignature(r.value) === sig)) return null;

    // (4) Single-valued conflict with a confirmed value.
    const conflictRows = confirmedConflicts(active, key, sig);
    const heldByConflict = conflictRows.length > 0 && !userDriven;
    const status: FactStatus = heldByConflict ? "proposed" : confidenceStatus;

    // Retire the prior confirmed value and link the chain via `supersedes_id`.
    if (userDriven) {
      await supersedeFacts(
        tx,
        parsed.userId,
        conflictRows.map((r) => r.id),
        parsed.validFrom ?? new Date(),
      );
    }

    const [row] = await tx
      .insert(userFacts)
      .values({
        userId: parsed.userId,
        key,
        value: parsed.value,
        confidence: parsed.confidence,
        status,
        source,
        validFrom: parsed.validFrom,
        validUntil: parsed.validUntil ?? null,
        supersedesId: userDriven ? (conflictRows[0]?.id ?? null) : null,
      })
      .returning();

    const inserted = rowToFact(requireRow(row, "proposeFact"));

    // Same tx as the fact, so a rollback leaves no phantom toast. A held conflict emits nothing.
    if (status === "confirmed") {
      await publishEvent({
        tx,
        userId: parsed.userId,
        kind: "memory.fact_learned",
        payload: {
          factId: inserted.id,
          key: inserted.key,
          preview: previewValue(inserted.value),
          confidence: inserted.confidence,
        },
      });
    }

    return inserted;
  });
}

/** One-line preview for toasts, at most 280 chars. */
function previewValue(value: unknown): string {
  const s = toDisplayText(value);

  return s.length > 280 ? s.slice(0, 277) + "…" : s;
}

// --- create (user-driven) ---

/**
 * A user's own fact: `confirmed` at confidence 1. It supersedes the prior confirmed value of a
 * single-valued key. `null` when an active row already holds the value, or `id` exists.
 */
export async function createFact(args: CreateFactArgs & FactExec): Promise<FactRow | null> {
  const parsed = createFactArgsSchema.parse(args);
  const { key, source } = canonicalKeyAndSource(parsed.key, parsed.source ?? { kind: "user" });
  const sig = valueSignature(parsed.value);

  return inFactTransaction(args.exec, parsed.userId, async (tx) => {
    await lockFactKey(tx, parsed.userId, key);
    const active = await activeFactsForKey(tx, parsed.userId, key);

    if (active.some((r) => valueSignature(r.value) === sig)) return null;

    const now = new Date();
    const conflicts = confirmedConflicts(active, key, sig);

    await supersedeFacts(
      tx,
      parsed.userId,
      conflicts.map((r) => r.id),
      now,
    );

    const [row] = await tx
      .insert(userFacts)
      .values({
        id: parsed.id,
        userId: parsed.userId,
        key,
        value: parsed.value,
        confidence: 1,
        status: "confirmed",
        source,
        validFrom: now,
        validUntil: null,
        supersedesId: conflicts[0]?.id ?? null,
      })
      .onConflictDoNothing()
      .returning();

    return row ? rowToFact(row) : null;
  });
}

// --- confirm ---

/**
 * Move a `proposed` row to `confirmed`. A repeat is a no-op. An alias key moves to its canonical
 * form, and the prior confirmed value of a single-valued key is superseded.
 */
export async function confirmFact({
  factId,
  userId,
  exec,
}: { factId: string; userId: string } & FactExec): Promise<FactRow | null> {
  return inFactTransaction(exec, userId, async (tx) => {
    const readProposed = async (): Promise<UserFact | undefined> => {
      const [row] = await tx
        .select()
        .from(userFacts)
        .where(
          and(
            eq(userFacts.id, factId),
            eq(userFacts.userId, userId),
            eq(userFacts.status, "proposed"),
          ),
        )
        .limit(1);

      return row;
    };

    const candidate = await readProposed();

    if (!candidate) return null;

    const { key, source } = canonicalKeyAndSource(candidate.key, candidate.source);
    await lockFactKey(tx, userId, key);

    // Read again under the lock: a concurrent confirm or reject may have moved the row.
    const old = await readProposed();

    if (!old) return null;

    const conflicts = confirmedConflicts(
      await activeFactsForKey(tx, userId, key),
      key,
      valueSignature(old.value),
      old.id,
    );

    await supersedeFacts(
      tx,
      userId,
      conflicts.map((r) => r.id),
      new Date(),
    );

    const [row] = await tx
      .update(userFacts)
      .set({
        key,
        source,
        status: "confirmed",
        supersedesId: conflicts[0]?.id ?? old.supersedesId,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(
        and(
          eq(userFacts.id, old.id),
          eq(userFacts.userId, userId),
          eq(userFacts.status, "proposed"),
        ),
      )
      .returning();

    return row ? rowToFact(row) : null;
  });
}

// --- reject ---

/** Mark `rejected` and record the signature, so extraction does not propose it again. Idempotent. */
export async function rejectFact(args: RejectFactArgs & FactExec): Promise<FactRow | null> {
  const parsed = rejectFactArgsSchema.parse(args);

  return inFactTransaction(args.exec, parsed.userId, async (tx) => {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, parsed.factId), eq(userFacts.userId, parsed.userId)))
      .limit(1);

    if (!old) return null;

    const [row] = await tx
      .update(userFacts)
      .set({
        status: "rejected",
        validUntil: new Date(),
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, parsed.factId))
      .returning();

    await tx
      .insert(rejectedInferences)
      .values({
        userId: parsed.userId,
        key: old.key,
        valueSignature: valueSignature(old.value),
        proposedFactId: old.id,
        reason: parsed.reason ?? null,
      })
      .onConflictDoNothing();

    return rowToFact(requireRow(row, "rejectFact.update"));
  });
}

// --- edit (user-driven supersession) ---

/**
 * A user edit: the old row becomes `edited`; a new confirmed row at confidence 1.0 supersedes
 * it, and the prior confirmed value of a single-valued key. `null` when `newFactId` exists.
 */
export async function editFact(args: EditFactArgs & FactExec): Promise<FactRow | null> {
  const parsed = editFactArgsSchema.parse(args);

  return inFactTransaction(args.exec, parsed.userId, async (tx) => {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, parsed.factId), eq(userFacts.userId, parsed.userId)))
      .limit(1);

    if (!old) return null;

    const { key, source } = canonicalKeyAndSource(old.key, parsed.source ?? { kind: "user" });
    await lockFactKey(tx, parsed.userId, key);
    const now = new Date();

    const conflicts = confirmedConflicts(
      await activeFactsForKey(tx, parsed.userId, key),
      key,
      valueSignature(parsed.newValue),
      old.id,
    );

    await supersedeFacts(
      tx,
      parsed.userId,
      conflicts.map((r) => r.id),
      now,
    );

    await tx
      .update(userFacts)
      .set({
        status: "edited",
        validUntil: now,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, parsed.factId));

    const [row] = await tx
      .insert(userFacts)
      .values({
        id: parsed.newFactId,
        userId: parsed.userId,
        key,
        value: parsed.newValue,
        confidence: 1,
        status: "confirmed",
        source,
        validFrom: now,
        validUntil: null,
        supersedesId: conflicts[0]?.id ?? old.id,
      })
      .onConflictDoNothing()
      .returning();

    return row ? rowToFact(row) : null;
  });
}

// --- supersede (system-driven) ---

/** A system replacement. The old row becomes `superseded`; the new status follows `confidence`. */
export async function supersedeFact(args: SupersedeFactArgs): Promise<FactRow | null> {
  const parsed = supersedeFactArgsSchema.parse(args);
  const now = new Date();
  const status: FactStatus = parsed.confidence >= AUTO_CONFIRM_THRESHOLD ? "confirmed" : "proposed";

  const fact = await db().transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(userFacts)
      .where(and(eq(userFacts.id, parsed.factId), eq(userFacts.userId, parsed.userId)))
      .limit(1);

    if (!old) return null;

    await tx
      .update(userFacts)
      .set({
        status: "superseded",
        validUntil: now,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(eq(userFacts.id, parsed.factId));

    const [row] = await tx
      .insert(userFacts)
      .values({
        userId: parsed.userId,
        key: old.key,
        value: parsed.newValue,
        confidence: parsed.confidence,
        status,
        source: parsed.source,
        validFrom: now,
        validUntil: null,
        supersedesId: old.id,
      })
      .returning();

    return rowToFact(requireRow(row, "supersedeFact.insert"));
  });

  if (fact) emitReplicachePokes([parsed.userId]);

  return fact;
}

// --- recall ---

export interface RecallOpts {
  /** Include `proposed` rows. Default false. */
  includeProposed?: boolean;
  /** Default 50. */
  limit?: number;
}

/**
 * Active rows for `(userId, key)` inside their validity window, newest first.
 * A key can hold several values, so there can be several rows.
 */
export async function recallActiveByKey(
  userId: string,
  key: string,
  opts: RecallOpts = {},
): Promise<FactRow[]> {
  const limit = opts.limit ?? 50;

  const statuses = opts.includeProposed
    ? or(eq(userFacts.status, "confirmed"), eq(userFacts.status, "proposed"))
    : eq(userFacts.status, "confirmed");

  const rows = await db()
    .select()
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, userId),
        eq(userFacts.key, key),
        statuses,
        lte(userFacts.validFrom, sql`now()`),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
      ),
    )
    .orderBy(desc(userFacts.validFrom))
    .limit(limit);

  return rows.map(rowToFact);
}

/** Latest active row for `(userId, key)`, or null. */
export async function recallLatestByKey(
  userId: string,
  key: string,
  opts: Omit<RecallOpts, "limit"> = {},
): Promise<FactRow | null> {
  const [row] = await recallActiveByKey(userId, key, { ...opts, limit: 1 });

  return row ?? null;
}

/** Facts by status, newest first, for the memory page. */
export async function listFactsByStatus(
  userId: string,
  status: FactStatus,
  limit = 100,
): Promise<FactRow[]> {
  const rows = await db()
    .select()
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), eq(userFacts.status, status)))
    .orderBy(desc(userFacts.updatedAt), asc(userFacts.id))
    .limit(limit);

  return rows.map(rowToFact);
}

/** Stops a corrupt or cyclic `supersedes_id` chain from running away. */
const MAX_SUPERSESSION_DEPTH = 256;

/** A `user_facts` row from the chain query. Its timestamps arrive as text and parse to `Date`. */
const supersessionChainRowSchema = createExecuteRowSchema(userFacts);

/**
 * The supersession chain, tip first, in one `WITH RECURSIVE` query scoped to
 * `userId`. Columns come from table metadata, so the parsed rows feed `rowToFact`.
 */
export async function getSupersessionChain(userId: string, factId: string): Promise<FactRow[]> {
  const columns = getTableColumns(userFacts);

  const projection = sql.join(
    Object.entries(columns).map(([jsName, column]) => sql`${column} as ${sql.identifier(jsName)}`),
    sql`, `,
  );

  const result = await db().execute(sql`
    with recursive chain as (
      select ${projection}, 0 as depth
        from ${userFacts}
       where ${userFacts.id} = ${factId} and ${userFacts.userId} = ${userId}
      union all
      select ${projection}, c.depth + 1
        from ${userFacts}
        join chain c on ${userFacts.id} = c.${sql.identifier("supersedesId")}
       where ${userFacts.userId} = ${userId} and c.depth < ${MAX_SUPERSESSION_DEPTH}
    )
    select * from chain order by depth
  `);

  return rowsFromExecute(result, supersessionChainRowSchema).map(rowToFact);
}
