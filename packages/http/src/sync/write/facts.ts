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

/**
 * Each mutator runs in a savepoint; on failure the LMID still advances.
 * `proposeFact` and its siblings write through `db()` and would escape the
 * savepoint, so these mutators repeat their logic against `tx`.
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
 * Confirm a `proposed` row. A repeat is a no-op. Like `confirmFact()`, it supersedes
 * the prior active value of a single-valued key.
 */
export async function factConfirm(
  tx: DbTransaction,
  args: FactConfirmArgs,
  userId: string,
): Promise<void> {
  const [candidate] = await tx
    .select()
    .from(userFacts)
    .where(
      and(
        eq(userFacts.id, args.factId),
        eq(userFacts.userId, userId),
        eq(userFacts.status, "proposed"),
      ),
    )
    .limit(1);

  if (!candidate) return;

  const key = canonicalFactKey(candidate.key);
  const source = canonicalSource(candidate.key, candidate.source);
  await lockFactKey(tx, userId, key);
  const now = new Date();

  const conflicts = await supersedeConflictingConfirmedFacts(
    tx,
    userId,
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
        eq(userFacts.userId, userId),
        eq(userFacts.status, "proposed"),
      ),
    );
}

/**
 * A user's own fact is `confirmed` at confidence 1. Idempotent on the client id.
 * It still canonicalizes the key and supersedes single-valued keys.
 */
export async function factCreate(
  tx: DbTransaction,
  args: FactCreateArgs,
  userId: string,
): Promise<void> {
  const key = canonicalFactKey(args.key);
  const source = canonicalSource(args.key, args.source ?? { kind: "user" });
  await lockFactKey(tx, userId, key);

  const sig = valueSignature(args.value);
  const active = await activeFactsForKey(tx, userId, key);

  if (active.some((row) => valueSignature(row.value) === sig)) return;

  const now = new Date();
  const conflicts = await supersedeConflictingConfirmedFacts(tx, userId, key, args.value, now);

  await tx
    .insert(userFacts)
    .values({
      id: args.id,
      userId,
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

/** Also record the (key, value) signature so extraction does not propose it again (ADR-0019). */
export async function factReject(
  tx: DbTransaction,
  args: FactRejectArgs,
  userId: string,
): Promise<void> {
  const [old] = await tx
    .select()
    .from(userFacts)
    .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, userId)))
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
      userId,
      key: old.key,
      valueSignature: valueSignature(old.value),
      proposedFactId: old.id,
      reason: args.reason ? { note: args.reason } : null,
    })
    .onConflictDoNothing();
}

/** The old row becomes `edited`; a new row links back by `supersedes_id`. Idempotent on `newFactId`. */
export async function factEdit(
  tx: DbTransaction,
  args: FactEditArgs,
  userId: string,
): Promise<void> {
  const [old] = await tx
    .select()
    .from(userFacts)
    .where(and(eq(userFacts.id, args.factId), eq(userFacts.userId, userId)))
    .limit(1);

  if (!old) return;

  const key = canonicalFactKey(old.key);
  const source = canonicalSource(old.key, args.source ?? { kind: "user" });
  const now = new Date();
  await lockFactKey(tx, userId, key);

  const conflicts = await supersedeConflictingConfirmedFacts(
    tx,
    userId,
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
      userId,
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
