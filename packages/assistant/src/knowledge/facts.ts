import {
  canonicalizeFactKey,
  claimAuthorSchema,
  claimEvidenceListSchema,
  claimProducerSchema,
  clamp01,
  toDisplayText,
  type ClaimAuthor,
  type ClaimEvidence,
  type ClaimProducer,
  type ClaimProvenance,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
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

/**
 * `user_facts.status` values (ADR-0019, ADR-0123). `proposed` is a claim that the user has not
 * confirmed; `retired` is a claim with no evidence that a check can read again.
 */
export const FACT_STATUSES = [
  "proposed",
  "confirmed",
  "rejected",
  "edited",
  "superseded",
  "retired",
] as const;

export const factStatusSchema = z.enum(FACT_STATUSES);

export type FactStatus = (typeof FACT_STATUSES)[number];

/**
 * The producer of a claim that this process writes: the pipeline, the run, the deployed commit
 * (ADR-0128 chain), and the model. A local run has no deployed commit, so it records null.
 */
export function claimProducer(args: {
  pipeline: string;
  runId?: string | null | undefined;
  model?: string | null | undefined;
}): ClaimProducer {
  const env = serverEnv();

  return {
    pipeline: args.pipeline,
    runId: args.runId ?? null,
    commit: env.RAILWAY_GIT_COMMIT_SHA || env.ALFRED_DEPLOYED_COMMIT_SHA || null,
    model: args.model ?? null,
  };
}

/** The user's own act on the memory page, now. */
function memoryPageEdit(action: "create" | "edit" | "confirm", at: Date) {
  return { kind: "user_edit", surface: "memory_page", action, at: at.toISOString() } as const;
}

const MEMORY_PAGE_PRODUCER = { pipeline: "memory-page" } as const;

// --- schemas ---

const proposeFactFieldsSchema = userFactInsertSchema
  .pick({
    userId: true,
    key: true,
    value: true,
    confidence: true,
    validFrom: true,
    validUntil: true,
  })
  .extend({
    userId: z.string().min(1),
    key: z.string().min(1).max(200),
    // `proposeFact` runs the per-key policy check.
    value: z.unknown(),
    /** Clamped to [0, 1]: model confidences have no enforced range. It is not evidence. */
    confidence: z.number().transform(clamp01),
  }) satisfies z.ZodType<
  Pick<NewUserFact, "userId" | "key" | "value" | "confidence" | "validFrom" | "validUntil">
>;

/**
 * A claim write. `ClaimProvenance` is a union on the author: a user claim must cite evidence that
 * only the user gives, so a mail or a page can never write one (#1889).
 */
export type ProposeFactArgs = z.input<typeof proposeFactFieldsSchema> & ClaimProvenance;

const createFactArgsSchema = z.object({
  /** A Replicache client mints it, so the optimistic row and the server row share one key. */
  id: z.string().min(1),
  userId: z.string().min(1),
  key: z.string().min(1).max(200),
  value: z.unknown(),
});

type CreateFactArgs = z.infer<typeof createFactArgsSchema>;

const editFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** The id of the replacement row. A Replicache client mints it; absent, the server does. */
  newFactId: z.string().min(1).optional(),
});

export type EditFactArgs = z.infer<typeof editFactArgsSchema>;

const supersedeFactFieldsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** Clamped like the confidence of `proposeFact`. */
  confidence: z.number().transform(clamp01),
});

export type SupersedeFactArgs = z.input<typeof supersedeFactFieldsSchema> & ClaimProvenance;

const rejectFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  reason: z.unknown().optional(),
});

export type RejectFactArgs = z.infer<typeof rejectFactArgsSchema>;

// --- row shape ---

/** `UserFact` with the zod-parsed `status`, `author`, `evidence`, and `producer` narrowed. */
export type FactRow = Omit<UserFact, "status" | "author" | "evidence" | "producer"> & {
  status: FactStatus;
  author: ClaimAuthor;
  evidence: ClaimEvidence[];
  producer: ClaimProducer;
};

/** INSERT…RETURNING gives `T | undefined`. */
function requireRow<T>(row: T | undefined, op: string): T {
  if (row == null) throw new Error(`[memory.facts] ${op} returned no row`);

  return row;
}

/** A raw row: the chain query reads the claim columns as plain JSON and text. */
type RawFactRow = Omit<UserFact, "author" | "evidence" | "producer"> & {
  author: string;
  evidence: unknown;
  producer: unknown;
};

function rowToFact(r: RawFactRow): FactRow {
  return {
    ...r,
    status: factStatusSchema.parse(r.status),
    author: claimAuthorSchema.parse(r.author),
    evidence: claimEvidenceListSchema.parse(r.evidence),
    producer: claimProducerSchema.parse(r.producer),
  };
}

/** The status of a new claim: the user's own claim is confirmed; an agent claim waits for the user. */
function statusAtWrite(author: ClaimAuthor): FactStatus {
  return author === "user" ? "confirmed" : "proposed";
}

// --- shared write steps ---

/**
 * A caller that already holds a transaction passes it as `exec` (a Replicache push passes its
 * savepoint `tx`). The write then commits or rolls back with it, and the caller pokes. A caller
 * with no transaction passes `"own"`: the write opens its own transaction and pokes after it.
 */
type FactExec = { exec: DbTransaction | "own" };

/** Serialize writes per `(userId, canonical key)`, or two writers can both add a confirmed single-valued row. */
async function lockFactKey(tx: DbTransaction, userId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
}

/** The canonical key. An unknown key stays as is. */
function canonicalKeyOf(rawKey: string) {
  const canon = canonicalizeFactKey(rawKey);

  return canon.ok ? { known: true, key: canon.key } : { known: false, key: rawKey };
}

/** `proposed` and `confirmed` rows for `(userId, key)`, `confirmed` first, then newest first. No `validFrom` upper bound: under the fact-key lock the reader's `now()` is its transaction start, so a bound would hide a row committed by the previous lock holder. `confirmed` sorts first so the 50-row cap cannot drop the confirmed row of a single-valued key behind newer proposals. */
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
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
      ),
    )
    .orderBy(asc(userFacts.status), desc(userFacts.createdAt))
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
 * Run `body` on `exec` when the caller holds a transaction. For `"own"`, open one, and poke
 * Replicache after it commits, so the client pull sees the row. `null` means no write to show.
 */
async function inFactTransaction<T>(
  exec: DbTransaction | "own",
  userId: string,
  body: (tx: DbTransaction) => Promise<T | null>,
): Promise<T | null> {
  if (exec !== "own") return body(exec);

  const result = await db().transaction(body);

  if (result !== null) emitReplicachePokes([userId]);

  return result;
}

// --- propose ---

/**
 * Insert a claim (ADR-0123). A user claim is confirmed; an agent claim is `proposed` until the
 * user confirms it (memory.md §9 Q6). The model's confidence confirms nothing.
 * The unbypassable backstop of the capture gate (#330, ADR-0079), in order:
 *  0. Canonicalize the key. An unknown key is rejected from a document; other
 *     evidence keeps it with a drift trace.
 *  0a. Drop relationship junk from any source (#492).
 *  1. Documents: reject `not_writable` keys and bad values. Authorship is the
 *     workflow gate's job.
 *  2. Skip a value the user already rejected.
 *  3. Skip an active duplicate.
 *  4. Single-valued conflict: a user claim supersedes the confirmed value; an agent claim is
 *     held as `proposed` beside it. Code cannot tell "the user moved" from a leaked contact
 *     value, so surface it instead of overwriting.
 */
export async function proposeFact(args: ProposeFactArgs): Promise<FactRow | null> {
  const parsed = proposeFactFieldsSchema.parse(args);
  const { author, evidence, producer } = args;
  const fromDocument = author === "agent" && evidence.some((link) => link.kind === "document");

  // (0) Canonicalize before any dedup or conflict check.
  const { known, key } = canonicalKeyOf(parsed.key);

  if (!known) {
    // Unknown key: reject from documents; keep from other evidence with a drift trace.
    if (fromDocument) return null;
    logger.warn(
      `[memory.facts] fact_key_unknown_non_document: persisting unknown key as-is ` +
        `(pipeline=${producer.pipeline}, key=${JSON.stringify(parsed.key)})`,
    );
  }

  // (0a) Relationship junk, from any source.
  if (known && isUninformativeRelationshipFact(key, parsed.value)) return null;

  // (1) Document write policy.
  if (fromDocument && known) {
    if (classifyDocumentFactKey(key) === "not_writable") return null;

    if (!validateFactValueForKey(key, parsed.value).ok) return null;
  }

  const sig = valueSignature(parsed.value);
  const userDriven = author === "user";
  const status = statusAtWrite(author);

  return inFactTransaction("own", parsed.userId, async (tx) => {
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

    // (4) Single-valued conflict with a confirmed value: only a user claim retires it.
    const conflictRows = userDriven ? confirmedConflicts(active, key, sig) : [];

    await supersedeFacts(
      tx,
      parsed.userId,
      conflictRows.map((r) => r.id),
      parsed.validFrom ?? new Date(),
    );

    const [row] = await tx
      .insert(userFacts)
      .values({
        userId: parsed.userId,
        key,
        value: parsed.value,
        confidence: parsed.confidence,
        status,
        author,
        evidence: [...evidence],
        producer,
        validFrom: parsed.validFrom ?? null,
        validUntil: parsed.validUntil ?? null,
        supersedesId: conflictRows[0]?.id ?? null,
      })
      .returning();

    const inserted = rowToFact(requireRow(row, "proposeFact"));

    // Same tx as the fact, so a rollback leaves no phantom toast. An unconfirmed claim emits nothing.
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
 * A user's own claim from the memory page: `confirmed` at confidence 1. It supersedes the prior
 * confirmed value of a single-valued key. `null` when an active row already holds the value, or
 * `id` exists. The start of validity is unknown: the user says it now, not since when.
 */
export async function createFact(args: CreateFactArgs & FactExec): Promise<FactRow | null> {
  const parsed = createFactArgsSchema.parse(args);
  const { key } = canonicalKeyOf(parsed.key);
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
        author: "user",
        evidence: [memoryPageEdit("create", now)],
        producer: claimProducer(MEMORY_PAGE_PRODUCER),
        validFrom: null,
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
 * The user confirms a `proposed` claim: it becomes `confirmed`, keeps its author, and cites the
 * user's confirm. A repeat is a no-op. An alias key moves to its canonical form, and the prior
 * confirmed value of a single-valued key is superseded.
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

    const { key } = canonicalKeyOf(candidate.key);
    await lockFactKey(tx, userId, key);

    // Read again under the lock: a committed concurrent confirm or reject may have moved the row.
    const old = await readProposed();

    if (!old) return null;

    const conflicts = confirmedConflicts(
      await activeFactsForKey(tx, userId, key),
      key,
      valueSignature(old.value),
      old.id,
    );

    const now = new Date();

    await supersedeFacts(
      tx,
      userId,
      conflicts.map((r) => r.id),
      now,
    );

    const [row] = await tx
      .update(userFacts)
      .set({
        key,
        evidence: [...claimEvidenceListSchema.parse(old.evidence), memoryPageEdit("confirm", now)],
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

    if (!row) return null;

    return rowToFact(row);
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
 * A user edit: the old row becomes `edited`; a new confirmed user claim at confidence 1.0
 * supersedes it, and the prior confirmed value of a single-valued key. `null` when `newFactId` exists.
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

    const { key } = canonicalKeyOf(old.key);
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
        author: "user",
        evidence: [memoryPageEdit("edit", now)],
        producer: claimProducer(MEMORY_PAGE_PRODUCER),
        validFrom: null,
        validUntil: null,
        supersedesId: conflicts[0]?.id ?? old.id,
      })
      .onConflictDoNothing()
      .returning();

    return row ? rowToFact(row) : null;
  });
}

// --- supersede (system-driven) ---

/** A replacement. The old row becomes `superseded`; the new status follows the author. */
export async function supersedeFact(args: SupersedeFactArgs): Promise<FactRow | null> {
  const parsed = supersedeFactFieldsSchema.parse(args);
  const now = new Date();
  const status = statusAtWrite(args.author);

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
        author: args.author,
        evidence: [...args.evidence],
        producer: args.producer,
        validFrom: null,
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
        or(isNull(userFacts.validFrom), lte(userFacts.validFrom, sql`now()`)),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
      ),
    )
    .orderBy(desc(userFacts.createdAt))
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
