import {
  canonicalizeFactKey,
  clamp01,
  memorySourceSchema,
  parseMemorySourceOrDefault,
  type MemorySource,
} from "@alfred/contracts";
import { db, rowsFromExecute } from "@alfred/db";
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

export const editFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** Defaults to `{ kind: 'user' }`. */
  source: memorySourceSchema.optional(),
});

export type EditFactArgs = z.infer<typeof editFactArgsSchema>;

export const supersedeFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** Clamped like `proposeFactArgsSchema.confidence`. */
  confidence: z.number().transform(clamp01),
  source: memorySourceSchema,
});

export type SupersedeFactArgs = z.infer<typeof supersedeFactArgsSchema>;

export const rejectFactArgsSchema = z.object({
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
  const canon = canonicalizeFactKey(parsed.key);

  if (!canon.ok) {
    // Unknown key: reject from documents; keep from trusted sources with a drift trace.
    if (isDocument) return null;
    console.warn(
      `[memory.facts] fact_key_unknown_non_document: persisting unknown key as-is ` +
        `(source=${parsed.source.kind}, key=${JSON.stringify(parsed.key)})`,
    );
  }

  const key = canon.ok ? canon.key : parsed.key;

  const source: MemorySource =
    canon.ok && canon.wasAlias
      ? { ...parsed.source, meta: { ...parsed.source.meta, originalKey: canon.originalKey } }
      : parsed.source;

  // (0a) Relationship junk, from any source.
  if (canon.ok && isUninformativeRelationshipFact(key, parsed.value)) return null;

  // (1) Document write policy.
  if (isDocument && canon.ok) {
    if (classifyDocumentFactKey(key) === "not_writable") return null;

    if (!validateFactValueForKey(key, parsed.value).ok) return null;
  }

  const sig = valueSignature(parsed.value);

  const confidenceStatus: FactStatus =
    parsed.confidence >= AUTO_CONFIRM_THRESHOLD ? "confirmed" : "proposed";

  const userDriven = parsed.source.kind === "user";

  const fact = await db().transaction(async (tx) => {
    // Serialize per `(userId, key)`, or two workers can both insert a confirmed single-valued row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${parsed.userId}:${key}`}, 0))`,
    );

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
    const active = (
      await tx
        .select()
        .from(userFacts)
        .where(
          and(
            eq(userFacts.userId, parsed.userId),
            eq(userFacts.key, key),
            or(eq(userFacts.status, "confirmed"), eq(userFacts.status, "proposed")),
            lte(userFacts.validFrom, sql`now()`),
            or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
          ),
        )
        .orderBy(desc(userFacts.validFrom))
        .limit(50)
    ).map(rowToFact);

    if (active.some((r) => valueSignature(r.value) === sig)) return null;

    // (4) Single-valued conflict with a confirmed value.
    let conflictRows: FactRow[] = [];

    if (isSingleValuedKey(key)) {
      const confirmed = active.filter((r) => r.status === "confirmed");
      conflictRows = confirmed.filter((r) => valueSignature(r.value) !== sig);
    }

    const heldByConflict = conflictRows.length > 0 && !userDriven;
    const status: FactStatus = heldByConflict ? "proposed" : confidenceStatus;

    // Retire the prior confirmed value and link the chain via `supersedes_id`.
    if (conflictRows.length > 0 && userDriven) {
      await tx
        .update(userFacts)
        .set({
          status: "superseded",
          validUntil: parsed.validFrom ?? new Date(),
          rowVersion: sql`${userFacts.rowVersion} + 1`,
        })
        .where(
          and(
            eq(userFacts.userId, parsed.userId),
            inArray(
              userFacts.id,
              conflictRows.map((r) => r.id),
            ),
          ),
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

  // Poke after commit so the client pull sees the row.
  if (!fact) return null;
  emitReplicachePokes([parsed.userId]);

  return fact;
}

/** One-line preview for toasts, at most 280 chars. */
function previewValue(value: unknown): string {
  let s: string;

  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }

  return s.length > 280 ? s.slice(0, 277) + "…" : s;
}

// --- confirm ---

/** Move a `proposed` row to `confirmed`. No-op if already confirmed. */
export async function confirmFact(factId: string, userId: string): Promise<FactRow | null> {
  const fact = await db().transaction(async (tx) => {
    const [candidate] = await tx
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

    if (!candidate) return null;

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${candidate.key}`}, 0))`,
    );

    const [old] = await tx
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

    if (!old) return null;

    const oldSig = valueSignature(old.value);
    let conflictRows: FactRow[] = [];

    if (isSingleValuedKey(old.key)) {
      conflictRows = (
        await tx
          .select()
          .from(userFacts)
          .where(
            and(
              eq(userFacts.userId, userId),
              eq(userFacts.key, old.key),
              eq(userFacts.status, "confirmed"),
              lte(userFacts.validFrom, sql`now()`),
              or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
            ),
          )
          .orderBy(desc(userFacts.validFrom))
          .limit(50)
      )
        .map(rowToFact)
        .filter((r) => valueSignature(r.value) !== oldSig);
    }

    if (conflictRows.length > 0) {
      await tx
        .update(userFacts)
        .set({
          status: "superseded",
          validUntil: new Date(),
          rowVersion: sql`${userFacts.rowVersion} + 1`,
        })
        .where(
          and(
            eq(userFacts.userId, userId),
            inArray(
              userFacts.id,
              conflictRows.map((r) => r.id),
            ),
          ),
        );
    }

    const [row] = await tx
      .update(userFacts)
      .set({
        status: "confirmed",
        supersedesId: conflictRows[0]?.id ?? old.supersedesId,
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

    if (!row) return null;

    return rowToFact(row);
  });

  if (fact) emitReplicachePokes([userId]);

  return fact;
}

// --- reject ---

/** Mark `rejected` and record the signature, so extraction does not propose it again. Idempotent. */
export async function rejectFact(args: RejectFactArgs): Promise<FactRow | null> {
  const parsed = rejectFactArgsSchema.parse(args);

  const fact = await db().transaction(async (tx) => {
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

  if (fact) emitReplicachePokes([parsed.userId]);

  return fact;
}

// --- edit (user-driven supersession) ---

/** A user edit: the old row becomes `edited`; a new confirmed row at confidence 1.0 supersedes it. */
export async function editFact(args: EditFactArgs): Promise<FactRow | null> {
  const parsed = editFactArgsSchema.parse(args);
  const source: MemorySource = parsed.source ?? { kind: "user" };
  const now = new Date();

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
        status: "edited",
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
        confidence: 1,
        status: "confirmed",
        source,
        validFrom: now,
        validUntil: null,
        supersedesId: old.id,
      })
      .returning();

    return rowToFact(requireRow(row, "editFact.insert"));
  });

  if (fact) emitReplicachePokes([parsed.userId]);

  return fact;
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

/**
 * The supersession chain, tip first, in one `WITH RECURSIVE` query scoped to
 * `userId`. Columns come from table metadata, so rows feed `rowToFact` unchanged.
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

  return rowsFromExecute<UserFact>(result).map(rowToFact);
}
