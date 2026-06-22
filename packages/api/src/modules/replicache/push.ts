import { db } from "@alfred/db";
import { replicacheClient, replicacheClientGroup } from "@alfred/db/schemas";
import { mutatorArgsSchemas, type MutatorName } from "@alfred/sync";
import { eq, sql } from "drizzle-orm";
import { publishPolicyBust } from "../action-policies";
import { emitReplicachePokes } from "../../events/replicache-events";
import { enqueueTriageRelabel } from "../triage/tags";
import { enqueueChatStorageCleanup } from "../integrations/queue";
import { MutatorForbiddenError } from "./authz";
import type { ReplicacheModel } from "./model";
import { serverMutators } from "./server-mutators";
import { toMessage } from "@alfred/contracts";

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
const POLICY_BUST_MUTATORS: ReadonlySet<MutatorName> = new Set([
  "policySetIntegrationMode",
  "policySetDefaultMode",
]);

/**
 * Mutators whose successful application must reconcile a Gmail label after
 * commit (rfc-triage-tags.md). The DB tag is committed in-transaction; the
 * external Gmail write can't be, so we enqueue a `triage.relabel` job per
 * affected thread once the transaction lands. Mirrors `POLICY_BUST_MUTATORS`.
 */
const RELABEL_MUTATORS: ReadonlySet<MutatorName> = new Set(["triageTagOverride"]);

/**
 * Mutators whose successful application must reap object-storage bytes after
 * commit (ADR-0065). Deleting a chat thread cascades its rows, but the attachment
 * objects in the bucket aren't reachable by FK — we drop their key prefix with a
 * `media.cleanup` job once the delete lands. Mirrors `RELABEL_MUTATORS`.
 */
const STORAGE_CLEANUP_MUTATORS: ReadonlySet<MutatorName> = new Set(["chatThreadDelete"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;
type ServerMutatorResult = void | { applied?: boolean };

function didMutatorApply(result: ServerMutatorResult | undefined): boolean {
  if (typeof result !== "object" || result === null) return true;
  return result.applied ?? true;
}

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
    | { forbidden: true }
    | {
        forbidden: false;
        needsPoke: boolean;
        needsPolicyBust: boolean;
        relabelThreads: string[];
        cleanupThreads: string[];
      }
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
    const relabelThreads: string[] = [];
    const cleanupThreads: string[] = [];

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
      let mutatorResult: ServerMutatorResult | undefined;
      try {
        // Savepoint isolates mutator failures so one bad mutation doesn't
        // poison the whole batch.
        await tx.transaction(async (subTx: DbTx) => {
          const runner = serverMutators[mutatorName] as (
            tx: DbTx,
            args: unknown,
            ctx: { userId: string },
          ) => Promise<ServerMutatorResult>;
          mutatorResult = await runner(subTx, parsed.data, { userId });
        });
        applied = didMutatorApply(mutatorResult);
      } catch (err) {
        if (err instanceof MutatorForbiddenError) {
          console.warn("[replicache:push] ACL rejected", mutatorName, err.message);
        } else {
          console.error("[replicache:push] mutator crashed", mutatorName, toMessage(err));
        }
      }

      // Advance LMID regardless of success so the client doesn't re-queue forever.
      await advanceLMID(tx, clientGroupID, mutation.clientID, mutation.id);

      if (applied) {
        needsPoke = true;
        if (POLICY_BUST_MUTATORS.has(mutatorName)) needsPolicyBust = true;
        if (RELABEL_MUTATORS.has(mutatorName)) {
          // `parsed.data` is the override schema's output — carries `threadId`.
          const threadId = (parsed.data as { threadId?: unknown }).threadId;
          if (typeof threadId === "string") relabelThreads.push(threadId);
        }
        if (STORAGE_CLEANUP_MUTATORS.has(mutatorName)) {
          // `chatThreadDelete` args carry the deleted thread's `id`.
          const id = (parsed.data as { id?: unknown }).id;
          if (typeof id === "string") cleanupThreads.push(id);
        }
      }
    }

    return { forbidden: false, needsPoke, needsPolicyBust, relabelThreads, cleanupThreads };
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
  if (outcome.needsPolicyBust) {
    await publishPolicyBust(userId);
  }

  // Reconcile each overridden thread's Gmail label off the request path. The
  // DB tag is already committed; the relabel job converges Gmail and is
  // idempotent, so a failed enqueue self-heals on the next override/classify.
  for (const sourceThreadId of outcome.relabelThreads) {
    try {
      await enqueueTriageRelabel(userId, sourceThreadId);
    } catch (err) {
      console.warn("[replicache:push] triage relabel enqueue failed:", toMessage(err));
    }
  }

  // Reap each deleted thread's attachment objects from the bucket (ADR-0065).
  // The rows already cascaded in-transaction; this drops the bytes by prefix.
  // Best-effort — a failed enqueue leaves orphaned objects (single-user,
  // near-zero cost) that the account-delete prefix sweep eventually reaps.
  for (const threadId of outcome.cleanupThreads) {
    try {
      await enqueueChatStorageCleanup(userId, `chat/${userId}/${threadId}/`);
    } catch (err) {
      console.warn("[replicache:push] chat storage cleanup enqueue failed:", toMessage(err));
    }
  }

  return {};
}
