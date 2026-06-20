import { db, rowsFromExecute } from "@alfred/db";
import { rejectedInferences, userFacts, type UserFact } from "@alfred/db/schemas";
import { and, asc, desc, eq, getTableColumns, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { publishEvent } from "../../events/publish";
import { emitReplicachePokes } from "../../events/replicache-events";
import { valueSignature } from "./signature";
import {
  AUTO_CONFIRM_THRESHOLD,
  factStatusSchema,
  memorySourceSchema,
  parseMemorySourceOrDefault,
  type FactStatus,
  type MemorySource,
} from "./types";

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

export const proposeFactArgsSchema = z.object({
  userId: z.string().min(1),
  key: z.string().min(1).max(200),
  /** Any JSON-serializable value. Extractor decides shape per key. */
  value: z.unknown(),
  /** [0, 1] — ≥ AUTO_CONFIRM_THRESHOLD auto-confirms. */
  confidence: z.number().min(0).max(1),
  source: memorySourceSchema,
  /** When the fact became true. Defaults to now() server-side. */
  validFrom: z.date().optional(),
  /** When the fact stopped being true. Usually NULL on a new proposal. */
  validUntil: z.date().nullable().optional(),
});
export type ProposeFactArgs = z.infer<typeof proposeFactArgsSchema>;

export const editFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  /** Defaults to `{ kind: 'user' }` — edits via UI. */
  source: memorySourceSchema.optional(),
});
export type EditFactArgs = z.infer<typeof editFactArgsSchema>;

export const supersedeFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  newValue: z.unknown(),
  confidence: z.number().min(0).max(1),
  source: memorySourceSchema,
});
export type SupersedeFactArgs = z.infer<typeof supersedeFactArgsSchema>;

export const rejectFactArgsSchema = z.object({
  factId: z.string().min(1),
  userId: z.string().min(1),
  reason: z.unknown().optional(),
});
export type RejectFactArgs = z.infer<typeof rejectFactArgsSchema>;

// ---------------------------------------------------------------------------
// row shape
// ---------------------------------------------------------------------------

/**
 * Like the DB row, but with the two jsonb columns narrowed to their parsed
 * shapes. Every other column tracks `UserFact` ($inferSelect) automatically —
 * only `status`/`source`, which `rowToFact` zod-parses, are restated.
 */
export type FactRow = Omit<UserFact, "status" | "source"> & {
  status: FactStatus;
  source: MemorySource;
};

/** Assertion helper for INSERT…RETURNING — drizzle's type is `T | undefined`. */
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

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

/**
 * Insert a new fact. Confidence ≥ AUTO_CONFIRM_THRESHOLD lands as
 * `confirmed`; lower stays `proposed` and waits for the correction-loop
 * UX (ADR-0019).
 *
 * Two idempotency guards:
 *
 *  1. **Rejection-aware.** Skip if `rejected_inferences` holds the same
 *     `(key, value-signature)` — the user already said no.
 *  2. **Active-dup guard.** Skip if there's already an active row
 *     (proposed *or* confirmed, within the validity window) with the
 *     same `(key, value-signature)`. Re-extraction over the same doc
 *     shouldn't pile up duplicates; the existing row already represents
 *     the claim. A future iteration can promote a stale `proposed` to
 *     `confirmed` when evidence accumulates — out of scope here.
 */
export async function proposeFact(args: ProposeFactArgs): Promise<FactRow | null> {
  const parsed = proposeFactArgsSchema.parse(args);
  const sig = valueSignature(parsed.value);

  // (1) Bypass if already rejected.
  const [rejectedHit] = await db()
    .select({ id: rejectedInferences.id })
    .from(rejectedInferences)
    .where(
      and(
        eq(rejectedInferences.userId, parsed.userId),
        eq(rejectedInferences.key, parsed.key),
        eq(rejectedInferences.valueSignature, sig),
      ),
    )
    .limit(1);
  if (rejectedHit) return null;

  // (2) Bypass if an active row with the same value already exists.
  const active = await recallActiveByKey(parsed.userId, parsed.key, {
    includeProposed: true,
  });
  if (active.some((r) => valueSignature(r.value) === sig)) return null;

  const status: FactStatus = parsed.confidence >= AUTO_CONFIRM_THRESHOLD ? "confirmed" : "proposed";

  const fact = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(userFacts)
      .values({
        userId: parsed.userId,
        key: parsed.key,
        value: parsed.value,
        confidence: parsed.confidence,
        status,
        source: parsed.source,
        validFrom: parsed.validFrom,
        validUntil: parsed.validUntil ?? null,
      })
      .returning();
    const inserted = rowToFact(requireRow(row, "proposeFact"));

    // Auto-confirm fires a soft-notification event in the same tx so the
    // outbox row commits atomically with the fact (no phantom toasts on
    // rollback). User-facing confirms via push handler emit nothing —
    // the Memory page UI already has its own affordance.
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

  // Poke after commit so the client's pull lands the new row.
  emitReplicachePokes([parsed.userId]);
  return fact;
}

/** ≤280-char one-line preview of a fact value, for soft-notification toasts. */
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

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

/** Move a `proposed` row to `confirmed`. No-op if already confirmed. */
export async function confirmFact(factId: string, userId: string): Promise<FactRow | null> {
  const [row] = await db()
    .update(userFacts)
    .set({ status: "confirmed", rowVersion: sql`${userFacts.rowVersion} + 1` })
    .where(
      and(eq(userFacts.id, factId), eq(userFacts.userId, userId), eq(userFacts.status, "proposed")),
    )
    .returning();
  if (!row) return null;
  emitReplicachePokes([userId]);
  return rowToFact(row);
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

/**
 * Mark the row `rejected` and capture its (key, value)-signature in
 * `rejected_inferences` so the extraction sub-agent doesn't re-propose
 * it. Idempotent on the signature row via the unique index.
 */
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

// ---------------------------------------------------------------------------
// edit (user-driven supersession)
// ---------------------------------------------------------------------------

/**
 * User edited a fact in the UI. Old row → `edited`; a new `confirmed`
 * row replaces it with `supersedes_id` linking back. The new row's
 * confidence is 1.0 — the user is the source of truth.
 */
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

// ---------------------------------------------------------------------------
// supersede (system-driven)
// ---------------------------------------------------------------------------

/**
 * System replacement (re-extraction with higher confidence, conflict
 * resolution). Old row → `superseded`; new row inherits confirm/proposed
 * status from `confidence` like `proposeFact`.
 */
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

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export interface RecallOpts {
  /** Include `proposed` rows (default false — only confirmed). */
  includeProposed?: boolean;
  /** Cap results. Default 50. */
  limit?: number;
}

/**
 * Currently-active rows for `(userId, key)` — confirmed by default,
 * with the temporal validity window applied: `valid_from <= now()
 * AND (valid_until IS NULL OR valid_until > now())`. Ordered newest first.
 *
 * Multiple active rows are legal: a single key can have multiple values
 * (`relationship:alice = mentor`, `relationship:alice = friend`). Callers
 * that want one row use `recallLatestByKey`.
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

/** Most recent active row for `(userId, key)` or null. */
export async function recallLatestByKey(
  userId: string,
  key: string,
  opts: Omit<RecallOpts, "limit"> = {},
): Promise<FactRow | null> {
  const [row] = await recallActiveByKey(userId, key, { ...opts, limit: 1 });
  return row ?? null;
}

/**
 * List facts by status — for the memory page (proposed cards, confirmed
 * facts list, recent-rejections audit). Ordered by recency.
 */
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

/**
 * Hard cap on supersession-chain length. A real chain is a handful of edits;
 * this only fires on a corrupt/cyclic `supersedes_id` pointer, bounding the
 * recursion so a bad row can't run the query away.
 */
const MAX_SUPERSESSION_DEPTH = 256;

/**
 * Walk the supersession chain from a row back to its origin, tip-first (the
 * queried row at index 0, the origin root last).
 *
 * One `WITH RECURSIVE` round trip instead of a query per hop: the base term
 * seeds the starting row, the recursive term follows `supersedes_id` (a row's
 * predecessor is the fact whose `id` equals the current row's `supersedes_id`),
 * scoped to `userId` at every level and bounded by {@link MAX_SUPERSESSION_DEPTH}.
 *
 * The column projection is generated from the table metadata so the raw rows
 * come back in `$inferSelect` (camelCase) shape — no hand-rolled column list to
 * drift from the schema — and feed `rowToFact` unchanged.
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
