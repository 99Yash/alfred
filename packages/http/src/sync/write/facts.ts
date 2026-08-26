import { isSingleValuedKey, valueSignature } from "@alfred/assistant/knowledge";
import { canonicalizeFactKey } from "@alfred/contracts";
import { rejectedInferences, userFacts, type UserFact } from "@alfred/db/schemas";
import type {
  FactConfirmArgs,
  FactCreateArgs,
  FactEditArgs,
  FactRejectArgs,
  MemorySource,
} from "@alfred/sync";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";
import type { ServerMutatorCtx } from "./mutator";

/**
 * Server-side mutators run inside the push handler's outer transaction
 * (via a per-mutator savepoint). Atomicity guarantees:
 *   - the mutator's writes commit together with the LMID advance, OR
 *   - the savepoint rolls back and the LMID still advances so the
 *     client doesn't re-queue the failed mutation forever.
 *
 * Memory primitives (`@alfred/assistant/knowledge`) open their
 * own transactions via `db()`, which would escape this savepoint. The
 * fact mutators below re-implement the same logic inline against the
 * supplied `tx` so atomicity is preserved.
 */
async function lockFactKey(tx: DbTransaction, userId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
}

function canonicalFactKey(rawKey: string): string {
  const canon = canonicalizeFactKey(rawKey);
  return canon.ok ? canon.key : rawKey;
}

function canonicalSource(rawKey: string, source: MemorySource): MemorySource {
  const canon = canonicalizeFactKey(rawKey);
  if (!canon.ok || !canon.wasAlias) return source;
  return { ...source, meta: { ...source.meta, originalKey: canon.originalKey } };
}

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
    .limit(50);
}

async function supersedeConflictingConfirmedFacts(
  tx: DbTransaction,
  userId: string,
  key: string,
  incomingValue: unknown,
  now: Date,
  excludeFactId?: string,
): Promise<UserFact[]> {
  if (!isSingleValuedKey(key)) return [];
  const incomingSig = valueSignature(incomingValue);
  const conflicts = (await activeFactsForKey(tx, userId, key)).filter(
    (row) =>
      row.id !== excludeFactId &&
      row.status === "confirmed" &&
      valueSignature(row.value) !== incomingSig,
  );
  if (conflicts.length === 0) return [];
  await tx
    .update(userFacts)
    .set({
      status: "superseded",
      validUntil: now,
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(
      and(
        eq(userFacts.userId, userId),
        inArray(
          userFacts.id,
          conflicts.map((row) => row.id),
        ),
      ),
    );
  return conflicts;
}

/**
 * Confirm a `proposed` row. No-op if the row is missing or already
 * past the proposed state — Replicache's at-least-once delivery means
 * confirm may arrive twice; the second is harmless. Mirrors
 * `confirmFact()`'s #330 single-valued invariant inside the push tx:
 * confirming a held conflict supersedes the prior active truth instead of
 * leaving two confirmed `employer`/`job_title`/etc. rows.
 */
export async function factConfirm(
  tx: DbTransaction,
  args: FactConfirmArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  const [candidate] = await tx
    .select()
    .from(userFacts)
    .where(
      and(
        eq(userFacts.id, args.factId),
        eq(userFacts.userId, ctx.userId),
        eq(userFacts.status, "proposed"),
      ),
    )
    .limit(1);
  if (!candidate) return;

  const key = canonicalFactKey(candidate.key);
  // SAFETY: user_facts.source is a jsonb column written only through the
  // mutators with memorySourceSchema-validated values; this read views it as
  // that stored shape.
  const source = canonicalSource(candidate.key, candidate.source as MemorySource);
  await lockFactKey(tx, ctx.userId, key);
  const now = new Date();
  const conflicts = await supersedeConflictingConfirmedFacts(
    tx,
    ctx.userId,
    key,
    candidate.value,
    now,
    candidate.id,
  );

  await tx
    .update(userFacts)
    .set({
      key,
      source,
      status: "confirmed",
      supersedesId: conflicts[0]?.id ?? candidate.supersedesId,
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(
      and(
        eq(userFacts.id, args.factId),
        eq(userFacts.userId, ctx.userId),
        eq(userFacts.status, "proposed"),
      ),
    );
}

/**
 * User-authored create: insert a `confirmed` user-sourced fact. Unlike
 * Alfred's extraction (which `proposeFact`s server-side and runs the
 * dedup/rejection guards), a user asserting a fact directly via the UI is
 * authoritative — confidence 1. Idempotent on id (client mints it before
 * push) so at-least-once redelivery is a harmless no-op. It still runs the
 * #330 canonical key + single-valued supersession invariant so direct user
 * writes cannot fork `company` from `employer` or leave two active truths.
 */
export async function factCreate(
  tx: DbTransaction,
  args: FactCreateArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  const key = canonicalFactKey(args.key);
  const source = canonicalSource(args.key, args.source ?? { kind: "user" });
  await lockFactKey(tx, ctx.userId, key);

  const sig = valueSignature(args.value);
  const active = await activeFactsForKey(tx, ctx.userId, key);
  if (active.some((row) => valueSignature(row.value) === sig)) return;

  const now = new Date();
  const conflicts = await supersedeConflictingConfirmedFacts(tx, ctx.userId, key, args.value, now);

  await tx
    .insert(userFacts)
    .values({
      id: args.id,
      userId: ctx.userId,
      key,
      value: args.value,
      confidence: 1,
      status: "confirmed",
      source,
      validFrom: now,
      validUntil: null,
      supersedesId: conflicts[0]?.id ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Reject a fact: mark the row + record the (key, value) signature so
 * the extraction sub-agent doesn't re-propose it (ADR-0019).
 */
export async function factReject(
  tx: DbTransaction,
  args: FactRejectArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  const [old] = await tx
    .select()
    .from(userFacts)
    .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, ctx.userId)))
    .limit(1);
  if (!old) return;

  await tx
    .update(userFacts)
    .set({
      status: "rejected",
      validUntil: new Date(),
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(eq(userFacts.id, args.factId));

  await tx
    .insert(rejectedInferences)
    .values({
      userId: ctx.userId,
      key: old.key,
      valueSignature: valueSignature(old.value),
      proposedFactId: old.id,
      reason: args.reason ? { note: args.reason } : null,
    })
    .onConflictDoNothing();
}

/**
 * User-edit: old row → `edited`, a new `confirmed` row replaces it
 * with `supersedes_id` linking back. Idempotent on `newFactId` —
 * the client mints it before pushing so a retry is a no-op.
 */
export async function factEdit(
  tx: DbTransaction,
  args: FactEditArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  const [old] = await tx
    .select()
    .from(userFacts)
    .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, ctx.userId)))
    .limit(1);
  if (!old) return;

  const key = canonicalFactKey(old.key);
  const source = canonicalSource(old.key, args.source ?? { kind: "user" });
  const now = new Date();
  await lockFactKey(tx, ctx.userId, key);
  const conflicts = await supersedeConflictingConfirmedFacts(
    tx,
    ctx.userId,
    key,
    args.newValue,
    now,
    old.id,
  );

  await tx
    .update(userFacts)
    .set({
      status: "edited",
      validUntil: now,
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(eq(userFacts.id, args.factId));

  await tx
    .insert(userFacts)
    .values({
      id: args.newFactId,
      userId: ctx.userId,
      key,
      value: args.newValue,
      confidence: 1,
      status: "confirmed",
      source,
      validFrom: now,
      validUntil: null,
      supersedesId: conflicts[0]?.id ?? old.id,
    })
    .onConflictDoNothing();
}
