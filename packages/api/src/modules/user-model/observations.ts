import { db } from "@alfred/db";
import { observationFamilyHeads, observations, type Observation } from "@alfred/db/schemas";
import { observationInsertSchema, type ObservationInsertInput } from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import { pgErrorChain } from "../../lib/pg-errors";
import { type DbExecutor } from "./executor";

const OBSERVATION_APPEND_MAX_ATTEMPTS = 3;
const OBSERVATION_CHAIN_CONSTRAINTS = new Set([
  "observations_no_fork_idx",
  "observations_single_root_idx",
]);

export interface InsertObservationResult {
  /** The persisted (or pre-existing, on dedup) observation row. */
  observation: Observation;
  /**
   * True when an identical-evidence row already existed and this call was a
   * no-op append (the dedup index collided). False when a new row was written.
   */
  deduped: boolean;
}

export interface AppendObservationFamilyMemberResult extends InsertObservationResult {
  status: "inserted" | "deduped";
}

export function isObservationAppendConflict(err: unknown): boolean {
  let sawUniqueViolation = false;
  let sawChainConstraint = false;
  for (const e of pgErrorChain(err)) {
    const message = e.message ?? "";
    sawUniqueViolation ||= e.code === "23505" || message.includes("23505");
    sawChainConstraint ||= Boolean(
      (e.constraint && OBSERVATION_CHAIN_CONSTRAINTS.has(e.constraint)) ||
      [...OBSERVATION_CHAIN_CONSTRAINTS].some((constraint) => message.includes(constraint)),
    );
    if (sawUniqueViolation && sawChainConstraint) return true;
  }
  return false;
}

async function lockObservationFamily(
  tx: DbExecutor,
  userId: string,
  familyKey: string,
): Promise<void> {
  const lockKey = `${userId}\u001f${familyKey}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

/**
 * THE observation write boundary (ADR-0067 P1 HARD GATE). Every reducer routes a
 * write through here; no module may call `.insert(observations)` directly. The
 * DB columns are bare `text`/`jsonb`, so this function — via
 * `observationInsertSchema` — is the only thing standing between a reducer bug
 * and a permanently-corrupt log. It does exactly three things, in one
 * transaction:
 *
 *   1. PARSE the input against the full contract (source×kind pair, canonical +
 *      format-checked subject/object identities, the participants fan-out
 *      envelope, byte-bounded idempotency keys, positive versions). A bad shape
 *      throws here, before any row is written.
 *   2. APPEND, dedup-aware: insert with `ON CONFLICT (user_id, family_key,
 *      evidence_hash) DO NOTHING`. Identical evidence collides and dedups (D4);
 *      the conflict target is the dedup index SPECIFICALLY, so a no-fork /
 *      single-root violation still throws (the CAS signal the reducer retries
 *      on — NOT swallowed).
 *   3. POINT the family head at the new live member (`observation_family_heads`
 *      upsert), inside the same transaction so the composite FK
 *      `(user_id, family_key, head_observation_id)` always resolves.
 *
 * What it deliberately does NOT do (reducer-owned, P1+): choosing
 * `supersedesObservationId`, multi-hop supersession cycle detection, and the
 * CAS-retry loop when `observations_no_fork_idx` / `observations_single_root_idx`
 * reject a concurrent write. This is the validated-append primitive those build on.
 */
export async function insertObservation(
  input: ObservationInsertInput,
  tx?: DbExecutor,
): Promise<InsertObservationResult> {
  const parsed = observationInsertSchema.parse(input);

  const run = async (ex: DbExecutor): Promise<InsertObservationResult> => {
    const [inserted] = await ex
      .insert(observations)
      .values({
        userId: parsed.userId,
        source: parsed.source,
        kind: parsed.kind,
        occurredAt: parsed.occurredAt,
        familyKey: parsed.familyKey,
        evidenceHash: parsed.evidenceHash,
        subjectIdentity: parsed.subjectIdentity,
        objectIdentity: parsed.objectIdentity ?? null,
        participants: parsed.participants,
        payload: parsed.payload,
        schemaVersion: parsed.schemaVersion,
        reducerVersion: parsed.reducerVersion,
        supersedesObservationId: parsed.supersedesObservationId ?? null,
      })
      // Dedup index ONLY — a no-fork / single-root unique violation must surface
      // so the reducer can retry against the new head, not be silently dropped.
      .onConflictDoNothing({
        target: [observations.userId, observations.familyKey, observations.evidenceHash],
      })
      .returning();

    if (!inserted) {
      // Dedup: an identical-evidence row already exists. Leave the head pointer
      // alone (the family is already established) and return the existing row.
      const [existing] = await ex
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.userId, parsed.userId),
            eq(observations.familyKey, parsed.familyKey),
            eq(observations.evidenceHash, parsed.evidenceHash),
          ),
        )
        .limit(1);
      if (!existing) {
        // The insert reported a conflict but the row isn't found — only possible
        // if it was deleted between the two statements (no concurrent deleter
        // exists in this design outside the user cascade). Fail loud rather than
        // return a phantom.
        throw new Error(
          "[user-model.insertObservation] dedup conflict but no existing observation found " +
            `(user=${parsed.userId}, family=${parsed.familyKey})`,
        );
      }
      return { observation: existing, deduped: true };
    }

    // New row: it is the live member of its family now (a root, or a successor
    // the reducer just appended). Move the head pointer to it.
    await ex
      .insert(observationFamilyHeads)
      .values({
        userId: parsed.userId,
        familyKey: parsed.familyKey,
        headObservationId: inserted.id,
      })
      .onConflictDoUpdate({
        target: [observationFamilyHeads.userId, observationFamilyHeads.familyKey],
        set: { headObservationId: inserted.id },
      });

    return { observation: inserted, deduped: false };
  };

  return tx ? run(tx) : db().transaction(run);
}

/**
 * Reducer-owned append helper for event-family supersession (ADR-0067 D4).
 *
 * `insertObservation` is the primitive: it validates and inserts the row it was
 * handed. This helper owns the higher-level family protocol reducers need:
 * read the current head, set `supersedesObservationId` to that head, and retry
 * when another writer wins the same family race first.
 */
export async function appendObservationFamilyMember(
  input: ObservationInsertInput,
): Promise<AppendObservationFamilyMemberResult> {
  const parsed = observationInsertSchema.parse(input);

  for (let attempt = 1; ; attempt++) {
    try {
      return await db().transaction(async (tx) => {
        await lockObservationFamily(tx, parsed.userId, parsed.familyKey);

        const [head] = await tx
          .select({ headObservationId: observationFamilyHeads.headObservationId })
          .from(observationFamilyHeads)
          .where(
            and(
              eq(observationFamilyHeads.userId, parsed.userId),
              eq(observationFamilyHeads.familyKey, parsed.familyKey),
            ),
          )
          .limit(1);

        const result = await insertObservation(
          {
            ...parsed,
            supersedesObservationId: head?.headObservationId ?? null,
          },
          tx,
        );

        return {
          ...result,
          status: result.deduped ? ("deduped" as const) : ("inserted" as const),
        };
      });
    } catch (err) {
      if (attempt >= OBSERVATION_APPEND_MAX_ATTEMPTS || !isObservationAppendConflict(err)) {
        throw err;
      }
    }
  }
}
