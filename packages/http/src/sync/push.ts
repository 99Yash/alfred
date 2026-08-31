import { db } from "@alfred/db";
import { runAtomic } from "@alfred/db/helpers";
import { replicacheClient, replicacheClientGroup } from "@alfred/db/schemas";
import type { MutatorName } from "@alfred/sync";
import { eq, sql } from "drizzle-orm";
import { publishPolicyBust } from "@alfred/assistant/action-policies";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import {
  enqueueChatStorageCleanup,
  enqueueTriageRelabel,
} from "@alfred/assistant/connections/ingestion";
import { toMessage } from "@alfred/contracts";
import { MutatorForbiddenError } from "./authz";
import type { ReplicacheModel } from "./model";
import {
  serverMutators,
  type MutatorFollowUp,
  type MutatorResult,
  type ServerMutatorCtx,
} from "./write";
import type { DbTransaction } from "@alfred/db";

export type PushRequestBody = ReplicacheModel.Push;
export type PushResponse =
  | Record<string, never>
  | { error: "ClientStateNotFound" | "VersionNotSupported" };

function isKnownMutator(name: string): name is MutatorName {
  return Object.prototype.hasOwnProperty.call(serverMutators, name);
}

// The push handler owns the outer transaction; `advanceLMID`/`getLMID` and the
// per-mutation savepoint (`subTx`) all run against a `DbTransaction`, never a
// pooled `db()` handle.
type MutationOutcome = { applied: boolean; followUps: MutatorFollowUp[] };

function didMutatorApply(result: MutatorResult | undefined): boolean {
  if (!result) return true;
  return result.applied ?? true;
}

/**
 * Validate and apply one mutation against its registry entry.
 *
 * `K` flows through a single lookup into `serverMutators` (a mapped template
 * over `MutatorName`), so the entry's arg schema and runner share one args
 * type: `parsed.data` is exactly what `entry.run` declares — no cast, and no
 * runtime path reads to recover fields later. Post-commit work comes back as
 * typed follow-up descriptors harvested by the entry itself.
 */
async function applyMutation<K extends MutatorName>(
  tx: DbTransaction,
  mutatorName: K,
  rawArgs: unknown,
  ctx: ServerMutatorCtx,
): Promise<MutationOutcome> {
  const outcome: MutationOutcome = { applied: false, followUps: [] };
  const entry = serverMutators[mutatorName];
  const parsed = entry.args.safeParse(rawArgs);
  if (!parsed.success) {
    console.warn("[replicache:push] invalid args for", mutatorName, parsed.error.issues);
    return outcome;
  }

  let mutatorResult: MutatorResult | undefined;
  try {
    // Savepoint isolates mutator failures so one bad mutation doesn't
    // poison the whole batch.
    await runAtomic(tx, async (subTx: DbTransaction) => {
      mutatorResult = await entry.run(subTx, parsed.data, ctx);
    });
  } catch (err) {
    if (err instanceof MutatorForbiddenError) {
      console.warn("[replicache:push] ACL rejected", mutatorName, err.message);
    } else {
      console.error("[replicache:push] mutator crashed", mutatorName, toMessage(err));
    }
    return outcome;
  }

  if (!didMutatorApply(mutatorResult)) return outcome;

  outcome.applied = true;
  if (entry.followUp) outcome.followUps = entry.followUp(ctx.userId, parsed.data);
  return outcome;
}

async function advanceLMID(
  tx: DbTransaction,
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

async function getLMID(tx: DbTransaction, clientID: string): Promise<number> {
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
    { forbidden: true } | { forbidden: false; needsPoke: boolean; followUps: MutatorFollowUp[] }
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
    let followUps: MutatorFollowUp[] = [];
    const ctx: ServerMutatorCtx = { userId };

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

      const lastMutationId = await getLMID(tx, mutation.clientID);
      if (mutation.id <= lastMutationId) {
        // Already applied — Replicache retries produce duplicates by design.
        continue;
      }

      const result = await applyMutation(tx, mutation.name, mutation.args, ctx);

      // Advance LMID regardless of success so the client doesn't re-queue forever.
      await advanceLMID(tx, clientGroupID, mutation.clientID, mutation.id);

      if (result.applied) {
        needsPoke = true;
        followUps = followUps.concat(result.followUps);
      }
    }

    return { forbidden: false, needsPoke, followUps };
  });

  if (outcome.forbidden) return { forbidden: true };

  // Poke AFTER the transaction commits so the client's pull sees the committed data.
  if (outcome.needsPoke) {
    try {
      emitReplicachePokes([userId]);
    } catch (err) {
      console.warn("[replicache:push] poke failed:", toMessage(err));
    }
  }

  // Bust the dispatcher's in-process policy cache across all instances AFTER
  // commit, so a gated→autonomy flip takes effect on the next dispatched tool
  // call. Best-effort (publishPolicyBust swallows Redis blips internally).
  // Once per push, however many policy flips the batch carried.
  if (outcome.followUps.some((f) => f.kind === "bustPolicyCache")) {
    await publishPolicyBust(userId);
  }

  // Everything below runs off the request path's critical data path, but the
  // ENQUEUE calls do not, and they are not bounded: BullMQ shares the
  // connection it is handed, so an `add` is an ordinary command on a
  // `"queue"`-kind handle, which `@alfred/db/redis` documents as unbounded in
  // every case. During a Redis outage each `await` below waits indefinitely and
  // its `catch` is unreachable. Every job is idempotent, so a lost enqueue
  // self-heals on the next override/classify/account sweep.

  // Reconcile overridden threads' Gmail labels: the DB tag committed above; the
  // relabel JOB converges Gmail.
  for (const f of outcome.followUps) {
    if (f.kind !== "relabelThread") continue;
    try {
      await enqueueTriageRelabel(userId, f.sourceThreadId);
    } catch (err) {
      console.warn("[replicache:push] triage relabel enqueue failed:", toMessage(err));
    }
  }

  // Reap deleted threads' attachment objects from the bucket (ADR-0065). The
  // rows cascaded in-transaction; this drops the bytes by prefix. Best-effort —
  // a failed enqueue leaves orphaned objects (single-user, near-zero cost) that
  // the account-delete prefix sweep eventually reaps.
  for (const f of outcome.followUps) {
    if (f.kind !== "cleanChatStorage") continue;
    try {
      await enqueueChatStorageCleanup(userId, `chat/${userId}/${f.threadId}/`);
    } catch (err) {
      console.warn("[replicache:push] chat storage cleanup enqueue failed:", toMessage(err));
    }
  }

  return {};
}
