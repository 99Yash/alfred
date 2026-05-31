import { db } from "@alfred/db";
import { replicacheClient, replicacheClientGroup } from "@alfred/db/schemas";
import { mutatorArgsSchemas, type MutatorName } from "@alfred/sync";
import { eq, sql } from "drizzle-orm";
import { publishPolicyBust } from "../action-policies";
import { emitReplicachePokes } from "../../events/replicache-events";
import { MutatorForbiddenError } from "./authz";
import type { ReplicacheModel } from "./model";
import { serverMutators } from "./server-mutators";

export type PushRequestBody = ReplicacheModel.Push;
export type PushResponse =
  | Record<string, never>
  | { error: "ClientStateNotFound" | "VersionNotSupported" };

function isKnownMutator(name: string): name is MutatorName {
  return Object.prototype.hasOwnProperty.call(mutatorArgsSchemas, name);
}

/**
 * Mutators whose successful application must also bust the dispatcher's
 * in-process policy cache (ADR-0034 amendment). `row_version` bump alone only
 * reaches browsers via Replicache pull; the gate runs server-side, so the
 * cache must drop too — fired after commit alongside the poke.
 */
const POLICY_BUST_MUTATORS: ReadonlySet<MutatorName> = new Set(["policySetIntegrationMode"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

async function advanceLMID(
  tx: DbTx,
  clientGroupID: string,
  clientID: string,
  newId: number,
): Promise<void> {
  await tx
    .insert(replicacheClient)
    .values({
      id: clientID,
      clientGroupId: clientGroupID,
      lastMutationId: newId,
      lastModified: new Date(),
    })
    .onConflictDoUpdate({
      target: replicacheClient.id,
      set: { lastMutationId: newId, lastModified: new Date() },
      setWhere: sql`${replicacheClient.lastMutationId} < ${newId}`,
    });
}

async function getLMID(tx: DbTx, clientID: string): Promise<number> {
  const [row] = await tx
    .select({ lmid: replicacheClient.lastMutationId })
    .from(replicacheClient)
    .where(eq(replicacheClient.id, clientID));
  return row?.lmid ?? 0;
}

export async function handlePush(
  userId: string,
  body: PushRequestBody,
): Promise<PushResponse | { forbidden: true }> {
  const { clientGroupID, mutations } = body;

  // Entire push runs inside one transaction: clientGroup bind + all mutation
  // writes + LMID advances. Per-mutation failures are isolated via savepoints.
  const outcome = await db().transaction<
    { forbidden: true } | { forbidden: false; needsPoke: boolean; needsPolicyBust: boolean }
  >(async (tx) => {
    const [group] = await tx
      .select()
      .from(replicacheClientGroup)
      .where(eq(replicacheClientGroup.id, clientGroupID));

    if (group) {
      if (group.userId !== userId) return { forbidden: true };
    } else {
      // Race: a concurrent first-push may have already inserted this clientGroup
      // under a different user. onConflictDoNothing silently succeeds, so re-read
      // and verify ownership before proceeding.
      await tx
        .insert(replicacheClientGroup)
        .values({ id: clientGroupID, userId, cvrVersion: 0 })
        .onConflictDoNothing();

      const [storedGroup] = await tx
        .select()
        .from(replicacheClientGroup)
        .where(eq(replicacheClientGroup.id, clientGroupID));

      if (!storedGroup || storedGroup.userId !== userId) return { forbidden: true };
    }

    let needsPoke = false;
    let needsPolicyBust = false;

    for (const mutation of mutations) {
      if (!isKnownMutator(mutation.name)) {
        await advanceLMID(tx, clientGroupID, mutation.clientID, mutation.id);
        console.warn(
          "[replicache:push] unknown mutator",
          mutation.name,
          "— LMID advanced to drop it",
        );
        continue;
      }

      const mutatorName: MutatorName = mutation.name;
      const schema = mutatorArgsSchemas[mutatorName];
      const parsed = schema.safeParse(mutation.args);
      if (!parsed.success) {
        await advanceLMID(tx, clientGroupID, mutation.clientID, mutation.id);
        console.warn("[replicache:push] invalid args for", mutatorName, parsed.error.issues);
        continue;
      }

      const lastMutationId = await getLMID(tx, mutation.clientID);
      if (mutation.id <= lastMutationId) {
        // Already applied — Replicache retries produce duplicates by design.
        continue;
      }

      let applied = false;
      try {
        // Savepoint isolates mutator failures so one bad mutation doesn't
        // poison the whole batch.
        await tx.transaction(async (subTx: DbTx) => {
          const runner = serverMutators[mutatorName] as (
            tx: DbTx,
            args: unknown,
            ctx: { userId: string },
          ) => Promise<void>;
          await runner(subTx, parsed.data, { userId });
        });
        applied = true;
      } catch (err) {
        if (err instanceof MutatorForbiddenError) {
          console.warn("[replicache:push] ACL rejected", mutatorName, err.message);
        } else {
          console.error(
            "[replicache:push] mutator crashed",
            mutatorName,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Advance LMID regardless of success so the client doesn't re-queue forever.
      await advanceLMID(tx, clientGroupID, mutation.clientID, mutation.id);

      if (applied) {
        needsPoke = true;
        if (POLICY_BUST_MUTATORS.has(mutatorName)) needsPolicyBust = true;
      }
    }

    return { forbidden: false, needsPoke, needsPolicyBust };
  });

  if (outcome.forbidden) return { forbidden: true };

  // Poke AFTER the transaction commits so the client's pull sees the committed data.
  if (outcome.needsPoke) {
    try {
      emitReplicachePokes([userId]);
    } catch (err) {
      console.warn(
        "[replicache:push] poke failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Bust the dispatcher's in-process policy cache across all instances AFTER
  // commit, so a gated→autonomy flip takes effect on the next dispatched tool
  // call. Best-effort (publishPolicyBust swallows Redis blips internally).
  if (outcome.needsPolicyBust) {
    await publishPolicyBust(userId);
  }

  return {};
}
