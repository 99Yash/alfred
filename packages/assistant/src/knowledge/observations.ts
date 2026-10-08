import { db } from "@alfred/db";
import { observationFamilyHeads, observations, type Observation } from "@alfred/db/schemas";
import { observationInsertSchema, type ObservationInsertInput } from "@alfred/contracts";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { PG_UNIQUE_VIOLATION, pgErrorChain } from "@alfred/db/pg-errors";
import { type DbTransaction } from "@alfred/db";

/**
 * Join to the live head of each observation family. Use as
 * `.innerJoin(observationFamilyHeads, liveObservationHeadJoin())`. Returns `SQL`,
 * never `undefined`, so a silent cross join cannot compile.
 */
export function liveObservationHeadJoin(): SQL {
  const predicate = and(
    eq(observationFamilyHeads.userId, observations.userId),
    eq(observationFamilyHeads.familyKey, observations.familyKey),
    eq(observationFamilyHeads.headObservationId, observations.id),
  );

  if (!predicate) {
    // Unreachable: three defined predicates never fold to undefined.
    throw new Error("[user-model] liveObservationHeadJoin produced an empty predicate");
  }

  return predicate;
}

const OBSERVATION_APPEND_MAX_ATTEMPTS = 3;

const OBSERVATION_CHAIN_CONSTRAINTS = new Set([
  "observations_no_fork_idx",
  "observations_single_root_idx",
]);

export interface InsertObservationResult {
  /** The new row, or the existing one on dedup. */
  observation: Observation;
  /** True when identical evidence already existed and nothing was written. */
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
    sawUniqueViolation ||= e.code === PG_UNIQUE_VIOLATION || message.includes(PG_UNIQUE_VIOLATION);
    sawChainConstraint ||= Boolean(
      (e.constraint && OBSERVATION_CHAIN_CONSTRAINTS.has(e.constraint)) ||
      [...OBSERVATION_CHAIN_CONSTRAINTS].some((constraint) => message.includes(constraint)),
    );

    if (sawUniqueViolation && sawChainConstraint) return true;
  }

  return false;
}

async function lockObservationFamily(
  tx: DbTransaction,
  userId: string,
  familyKey: string,
): Promise<void> {
  const lockKey = `${userId}\u001f${familyKey}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

/**
 * The observation write boundary (ADR-0067 P1 hard gate). Nothing else may
 * `.insert(observations)`. In one transaction: parse against the full contract,
 * append with dedup on identical evidence (D4), and move the family head.
 * No-fork and single-root violations still throw, so the reducer can retry.
 */
export async function insertObservation(
  input: ObservationInsertInput,
  tx?: DbTransaction,
): Promise<InsertObservationResult> {
  const parsed = observationInsertSchema.parse(input);

  const run = async (ex: DbTransaction): Promise<InsertObservationResult> => {
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
      // Dedup index only: no-fork and single-root violations must surface.
      .onConflictDoNothing({
        target: [observations.userId, observations.familyKey, observations.evidenceHash],
      })
      .returning();

    if (!inserted) {
      // Dedup: return the existing row; the head pointer stays.
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
        // Only possible if the row was deleted between the two statements.
        throw new Error(
          "[user-model.insertObservation] dedup conflict but no existing observation found " +
            `(user=${parsed.userId}, family=${parsed.familyKey})`,
        );
      }

      return { observation: existing, deduped: true };
    }

    // The new row is the family's live member now.
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
 * Append a family member that supersedes the current head (ADR-0067 D4), and
 * retry when another writer wins the race.
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
