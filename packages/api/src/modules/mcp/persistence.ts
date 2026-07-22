/**
 * MCP persistence layer (PRD #540) — pure durable row access + the small set of
 * atomic operations the connection manager and execution broker sit on top of.
 *
 * This module holds NO live SDK clients and performs NO network I/O: it is the
 * seam between the in-memory `McpRawClient` world and the four `mcp_*` tables
 * (`packages/db/src/schema/mcp.ts`). Everything here is either a single-row read,
 * a single-row write, or one of the few genuinely-atomic multi-row operations
 * that MUST be a transaction to be crash-safe:
 *
 *  - `publishCatalogRevision` — idempotent insert of an immutable revision +
 *    advance of the connection's current-revision pointer.
 *  - `insertInvocation` — the barrier reservation. Inserting the ledger row IS
 *    the reservation; the partial unique index rejects a duplicate unresolved
 *    proposal, surfaced here as `{ ok: false, reason: "barrier" }`.
 *  - `createSuccessorInvocation` — resolve the prior invocation AND mint its
 *    successor in one transaction, so the prior leaves the partial barrier index
 *    exactly as the successor enters it.
 *  - `reconcileInflightInvocations` — the crash-recovery barrier sweep run at
 *    boot (issue clarification #1).
 */

import { isIndexable } from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import {
  mcpCatalogRevisions,
  mcpConnections,
  mcpInvocation,
  mcpToolPolicy,
  type McpCatalogRevision,
  type McpConnection,
  type McpInvocation,
  type McpToolPolicyRow,
  type NewMcpConnection,
  type NewMcpInvocation,
  type NewMcpToolPolicyRow,
} from "@alfred/db/schemas";
import { and, eq, isNull, sql } from "drizzle-orm";

/** A transaction handle or the root client — either can run a query. */
type Db = DbTransaction | ReturnType<typeof db>;

// ===========================================================================
// Postgres error narrowing. A unique-violation surfaces as a `DatabaseError`
// *class instance* — `isRecord` rejects those (see the code-review lesson), so
// the code/constraint are read via `isIndexable` + `Reflect.get`.
// ===========================================================================

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Assert an `INSERT ... RETURNING` produced its row. `noUncheckedIndexedAccess`
 * types `const [row] = ...returning()` as `T | undefined`, but an insert without
 * a swallowed conflict always yields exactly one row; a missing one is a bug, not
 * a normal outcome, so it throws rather than propagating `undefined`.
 */
function requireRow<T>(row: T | undefined, op: string): T {
  if (row === undefined) throw new Error(`mcp persistence: ${op} returned no row`);
  return row;
}

/**
 * Run `body` atomically, reusing the caller's transaction if one was passed and
 * opening a fresh one otherwise. Lets a multi-step persistence op compose inside a
 * larger transaction (the push handler's, say) without nesting a second one.
 */
function runAtomic<T>(runner: Db, body: (tx: Db) => Promise<T>): Promise<T> {
  return "transaction" in runner ? runner.transaction(body) : body(runner);
}

/**
 * If `err` is a Postgres unique-violation, return the violated constraint name
 * (or `""` when the driver omitted it); otherwise `undefined`. drizzle-orm wraps
 * the driver error in a "Failed query" error, so the real `DatabaseError` — with
 * `.code`/`.constraint` — lives on `.cause`; both levels are inspected. Fields on
 * a caught error are read with `isIndexable` + `Reflect.get`, never `isRecord`
 * (which rejects Error/driver class instances — see the code-cause lesson).
 */
function pgConstraintOnUniqueViolation(err: unknown): string | undefined {
  const candidates = [err, isIndexable(err) ? Reflect.get(err, "cause") : undefined];
  for (const candidate of candidates) {
    if (!isIndexable(candidate)) continue;
    if (Reflect.get(candidate, "code") !== PG_UNIQUE_VIOLATION) continue;
    const constraint = Reflect.get(candidate, "constraint");
    return typeof constraint === "string" ? constraint : "";
  }
  return undefined;
}

// ===========================================================================
// Connections
// ===========================================================================

/** Columns a caller may mutate on a connection after creation. */
export type McpConnectionUpdate = Partial<
  Pick<
    NewMcpConnection,
    | "label"
    | "status"
    | "negotiatedProtocolVersion"
    | "serverIdentity"
    | "currentCatalogRevisionId"
    | "lastConnectedAt"
    | "lastError"
    | "authServerIdentity"
    | "credentialId"
    | "grantedScopes"
    | "endpointUrl"
    | "endpointOrigin"
  >
>;

export async function readConnection(
  id: string,
  runner: Db = db(),
): Promise<McpConnection | undefined> {
  const [row] = await runner
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.id, id))
    .limit(1);
  return row;
}

export async function insertConnection(
  values: NewMcpConnection,
  runner: Db = db(),
): Promise<McpConnection> {
  const [row] = await runner.insert(mcpConnections).values(values).returning();
  return requireRow(row, "insertConnection");
}

export async function updateConnection(
  id: string,
  patch: McpConnectionUpdate,
  runner: Db = db(),
): Promise<McpConnection | undefined> {
  const [row] = await runner
    .update(mcpConnections)
    .set(patch)
    .where(eq(mcpConnections.id, id))
    .returning();
  return row;
}

// ===========================================================================
// Catalog revisions (immutable, append-only)
// ===========================================================================

export async function readRevisionById(
  id: string,
  runner: Db = db(),
): Promise<McpCatalogRevision | undefined> {
  const [row] = await runner
    .select()
    .from(mcpCatalogRevisions)
    .where(eq(mcpCatalogRevisions.id, id))
    .limit(1);
  return row;
}

export async function readRevisionByHash(
  connectionId: string,
  revisionHash: string,
  runner: Db = db(),
): Promise<McpCatalogRevision | undefined> {
  const [row] = await runner
    .select()
    .from(mcpCatalogRevisions)
    .where(
      and(
        eq(mcpCatalogRevisions.connectionId, connectionId),
        eq(mcpCatalogRevisions.revisionHash, revisionHash),
      ),
    )
    .limit(1);
  return row;
}

/** The revision currently pointed at by the connection, if any. */
export async function readCurrentRevision(
  connectionId: string,
  runner: Db = db(),
): Promise<McpCatalogRevision | undefined> {
  const connection = await readConnection(connectionId, runner);
  if (!connection?.currentCatalogRevisionId) return undefined;
  return readRevisionById(connection.currentCatalogRevisionId, runner);
}

export interface PublishCatalogRevisionInput {
  connectionId: string;
  /** Stable authority hash (`McpCatalogSnapshot.revision`, "sha256:..."). */
  revisionHash: string;
  /** Raw, validated descriptors exactly as admitted by the raw client (`Tool[]`). */
  descriptors: unknown;
  /** `{ [remoteName]: descriptorHash }` from `computeDescriptorHashes`. */
  descriptorHashes: Record<string, string>;
  toolCount: number;
}

/**
 * The ONE genuinely-atomic catalog operation: publish (or re-use) an immutable
 * revision and advance the connection's current-revision pointer to it, in a
 * single transaction. Idempotent on `(connectionId, revisionHash)` — refreshing
 * an unchanged catalog returns the existing revision without inserting a
 * duplicate, and re-publishing is a no-op pointer write.
 *
 * The insert uses `onConflictDoNothing` so a concurrent publisher racing on the
 * same hash cannot produce two rows; the loser reads the winner's row back.
 */
export async function publishCatalogRevision(
  input: PublishCatalogRevisionInput,
  runner: Db = db(),
): Promise<McpCatalogRevision> {
  const run = (tx: Db) => publishCatalogRevisionInTx(input, tx);
  // Reuse a caller's transaction when given one; otherwise open our own.
  return runAtomic(runner, run);
}

async function publishCatalogRevisionInTx(
  input: PublishCatalogRevisionInput,
  tx: Db,
): Promise<McpCatalogRevision> {
  const [inserted] = await tx
    .insert(mcpCatalogRevisions)
    .values({
      connectionId: input.connectionId,
      revisionHash: input.revisionHash,
      descriptors: input.descriptors,
      descriptorHashes: input.descriptorHashes,
      toolCount: input.toolCount,
    })
    .onConflictDoNothing({
      target: [mcpCatalogRevisions.connectionId, mcpCatalogRevisions.revisionHash],
    })
    .returning();

  const revision =
    inserted ?? (await readRevisionByHash(input.connectionId, input.revisionHash, tx));
  if (!revision) {
    // Unreachable: the row was either just inserted or already present.
    throw new Error(
      `publishCatalogRevision: revision vanished for connection ${input.connectionId}`,
    );
  }

  await tx
    .update(mcpConnections)
    .set({ currentCatalogRevisionId: revision.id })
    .where(eq(mcpConnections.id, input.connectionId));

  return revision;
}

// ===========================================================================
// Per-tool policy (reviewed effect/retry/tier, bound to a descriptor hash)
// ===========================================================================

export async function readToolPolicy(
  connectionId: string,
  remoteName: string,
  descriptorHash: string,
  runner: Db = db(),
): Promise<McpToolPolicyRow | undefined> {
  const [row] = await runner
    .select()
    .from(mcpToolPolicy)
    .where(
      and(
        eq(mcpToolPolicy.connectionId, connectionId),
        eq(mcpToolPolicy.remoteName, remoteName),
        eq(mcpToolPolicy.descriptorHash, descriptorHash),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Upsert the reviewed policy for a `(connection, remoteName, descriptorHash)`.
 * The descriptor hash is part of the key on purpose: a policy is bound to the
 * EXACT descriptor it was reviewed against, so descriptor drift produces a fresh
 * key (a miss) and the resolver falls back to the static `high` floor rather
 * than silently reusing a downgrade granted for a different descriptor.
 */
export async function upsertToolPolicy(
  values: NewMcpToolPolicyRow,
  runner: Db = db(),
): Promise<McpToolPolicyRow> {
  const [row] = await runner
    .insert(mcpToolPolicy)
    .values(values)
    .onConflictDoUpdate({
      target: [mcpToolPolicy.connectionId, mcpToolPolicy.remoteName, mcpToolPolicy.descriptorHash],
      set: {
        policyRevision: values.policyRevision,
        riskTier: values.riskTier,
        effectClass: values.effectClass,
        retryContract: values.retryContract,
        reviewedAt: values.reviewedAt,
        reviewedNote: values.reviewedNote,
      },
    })
    .returning();
  return requireRow(row, "upsertToolPolicy");
}

// ===========================================================================
// Operation ledger
// ===========================================================================

/** Result of a barrier reservation attempt. */
export type InsertInvocationResult =
  | { ok: true; invocation: McpInvocation }
  | { ok: false; reason: "barrier" | "duplicate_staging" };

/**
 * Reserve an operation by inserting its ledger row. The row is minted BEFORE
 * network dispatch, so a crash mid-flight still leaves durable evidence. The row
 * insert IS the ambiguity barrier: the partial unique index on
 * `(user, connection, remoteName, argsHash) WHERE resolvedAt IS NULL` rejects a
 * second unresolved proposal identical to an in-flight/blocked one (23505), and
 * the 1:1 `staging_id` index rejects a re-insert for the same staging row. Both
 * are reported as a typed non-throwing result so the broker decides the arm.
 */
export async function insertInvocation(
  values: NewMcpInvocation,
  runner: Db = db(),
): Promise<InsertInvocationResult> {
  try {
    const [invocation] = await runner.insert(mcpInvocation).values(values).returning();
    return { ok: true, invocation: requireRow(invocation, "insertInvocation") };
  } catch (err) {
    const constraint = pgConstraintOnUniqueViolation(err);
    if (constraint === undefined) throw err;
    if (constraint === "mcp_invocation_staging_idx") {
      return { ok: false, reason: "duplicate_staging" };
    }
    // The barrier index (or an unnamed unique violation defaulting to barrier).
    return { ok: false, reason: "barrier" };
  }
}

/** Fields the broker patches onto a ledger row as an operation progresses. */
export type McpInvocationUpdate = Partial<
  Pick<
    NewMcpInvocation,
    | "attemptLifecycle"
    | "effectOutcome"
    | "retryDisposition"
    | "descriptorHash"
    | "policyRevision"
    | "catalogRevisionId"
    | "effectClass"
    | "resolvedAt"
    | "resolutionReason"
    | "lastError"
  >
>;

export async function updateInvocation(
  id: string,
  patch: McpInvocationUpdate,
  runner: Db = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .update(mcpInvocation)
    .set(patch)
    .where(eq(mcpInvocation.id, id))
    .returning();
  return row;
}

/**
 * The invocation minted for a staging row, if any. The `mcp_invocation_staging_idx`
 * enforces this is at most one. Used by the broker to recover the prior operation
 * when a re-dispatch of the SAME staging row collides with the 1:1 index (a crash
 * between minting the invocation and marking the staging row `executed`): the
 * broker reads the recorded state rather than re-delivering.
 */
export async function readInvocationByStagingId(
  stagingId: string,
  runner: Db = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .select()
    .from(mcpInvocation)
    .where(eq(mcpInvocation.stagingId, stagingId))
    .limit(1);
  return row;
}

/**
 * The single unresolved operation matching a proposal, if one exists — the same
 * shape the partial barrier index enforces. Lets the broker read WHY a repeat is
 * blocked (to explain it) instead of only learning it collided.
 */
export async function findUnresolvedBarrier(
  key: { userId: string; connectionId: string; remoteName: string; argsHash: string },
  runner: Db = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .select()
    .from(mcpInvocation)
    .where(
      and(
        eq(mcpInvocation.userId, key.userId),
        eq(mcpInvocation.connectionId, key.connectionId),
        eq(mcpInvocation.remoteName, key.remoteName),
        eq(mcpInvocation.argsHash, key.argsHash),
        isNull(mcpInvocation.resolvedAt),
      ),
    )
    .limit(1);
  return row;
}

export interface CreateSuccessorInput {
  /** The prior invocation this successor supersedes. */
  priorId: string;
  /** Why the prior is being resolved (e.g. "superseded_by_successor"). */
  priorResolutionReason: string;
  /** The successor ledger row. `successorOf` is set here — never by the caller. */
  successor: Omit<NewMcpInvocation, "successorOf">;
}

/**
 * Outcome of a successor mint. A successor may only supersede a GENUINELY
 * unresolved prior; if the prior was already resolved (reconciled, raced to a
 * definitive outcome, or a stale id), no successor is minted.
 */
export type CreateSuccessorResult =
  | { ok: true; successor: McpInvocation }
  | { ok: false; reason: "prior_already_resolved" };

/**
 * Resolve the prior invocation AND insert its successor atomically. Only this
 * host-owned path may set `successorOf`; the model cannot mint a successor
 * (issue clarification #4 — authorization is minted at the approval boundary,
 * tied to the prior invocation). Resolving the prior in the same transaction
 * clears the partial barrier index exactly as the successor enters it, so the
 * successor insert does not collide with the row it replaces.
 *
 * The resolve is guarded on its affected-row count: the UPDATE matches only an
 * unresolved prior (`resolvedAt IS NULL`), so a zero-row result means the prior
 * was ALREADY resolved. Minting a successor against a settled prior would open a
 * fresh unresolved barrier for a write that is no longer ambiguous, so this
 * refuses instead — moving the "prior must be unresolved" precondition off an
 * assumed caller and into the transaction.
 */
export async function createSuccessorInvocation(
  input: CreateSuccessorInput,
  runner: Db = db(),
): Promise<CreateSuccessorResult> {
  const run = async (tx: Db): Promise<CreateSuccessorResult> => {
    const resolvedPrior = await tx
      .update(mcpInvocation)
      .set({ resolvedAt: sql`now()`, resolutionReason: input.priorResolutionReason })
      .where(and(eq(mcpInvocation.id, input.priorId), isNull(mcpInvocation.resolvedAt)))
      .returning({ id: mcpInvocation.id });

    if (resolvedPrior.length === 0) {
      return { ok: false, reason: "prior_already_resolved" };
    }

    const [successor] = await tx
      .insert(mcpInvocation)
      .values({ ...input.successor, successorOf: input.priorId })
      .returning();
    return { ok: true, successor: requireRow(successor, "createSuccessorInvocation") };
  };
  return runAtomic(runner, run);
}

export interface ReconcileSummary {
  /** `prepared` rows that never reached delivery — safe, resolved. */
  abandoned: number;
  /** `delivery_possible` reads that are idempotent — safe, resolved. */
  resolvedReads: number;
  /** `delivery_possible` effectful rows — outcome unknown, left BLOCKED. */
  markedUnknown: number;
}

/**
 * Crash-recovery sweep, run at boot before any new dispatch (clarification #1).
 * Three transitions over rows left unresolved by a previous process:
 *
 *  - `prepared`: the row was reserved but the raw-client call was never made
 *    (no delivery possible). Resolve it — the barrier should not block a fresh
 *    attempt of an operation that provably never left the host.
 *  - `delivery_possible` + `read`: a read is idempotent, so an ambiguous read is
 *    safe to resolve and re-run; it never needed the block.
 *  - `delivery_possible` + `write`/`unknown` + no outcome: the effect is
 *    genuinely ambiguous. Mark the outcome `unknown` / disposition `blocked` but
 *    leave `resolvedAt` NULL so the barrier keeps rejecting an identical repeat
 *    until a host-minted successor (or explicit user resolution) clears it.
 */
export async function reconcileInflightInvocations(
  userId?: string,
  runner: Db = db(),
): Promise<ReconcileSummary> {
  const run = async (tx: Db): Promise<ReconcileSummary> => {
    const scope = userId ? [eq(mcpInvocation.userId, userId)] : [];

    const abandoned = await tx
      .update(mcpInvocation)
      .set({
        resolvedAt: sql`now()`,
        resolutionReason: "reconciled_abandoned",
        retryDisposition: "safe",
      })
      .where(
        and(
          ...scope,
          eq(mcpInvocation.attemptLifecycle, "prepared"),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id });

    const resolvedReads = await tx
      .update(mcpInvocation)
      .set({
        resolvedAt: sql`now()`,
        resolutionReason: "reconciled_read_safe",
        retryDisposition: "safe",
      })
      .where(
        and(
          ...scope,
          eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
          eq(mcpInvocation.effectClass, "read"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id });

    const markedUnknown = await tx
      .update(mcpInvocation)
      .set({
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        resolutionReason: "reconciled_ambiguous",
      })
      .where(
        and(
          ...scope,
          eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id });

    return {
      abandoned: abandoned.length,
      resolvedReads: resolvedReads.length,
      markedUnknown: markedUnknown.length,
    };
  };
  return runAtomic(runner, run);
}
