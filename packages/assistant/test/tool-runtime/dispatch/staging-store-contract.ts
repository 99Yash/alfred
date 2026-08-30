/**
 * The shared `StagingStore` contract — run against BOTH adapters.
 *
 * This file is the whole mitigation for the one risk the seam carries: if the
 * in-memory adapter drifts from Postgres, the DB-free gate suite goes green
 * against a machine the real adapter does not honour, and every claim it makes
 * is worthless — strictly worse than an honest skip. So the rule is: if this
 * suite is dropped, or is run against only one adapter, the seam has made
 * verification worse and should be reverted.
 *
 * What it pins is the store's own promises, not the gate's. The gate's ordering
 * rules are `staging-machine.test.ts`.
 *
 * Postgres-only semantics that a fake structurally cannot prove — the `xmax = 0`
 * insert-vs-conflict flag and the no-op `SET row_version = row_version` — stay
 * in `staging.test.ts`. Faking them would delete the subject.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ActionStagingStatus, EffectOutcome, RunStatus } from "@alfred/contracts";

import type {
  StagingInsertValues,
  StagingStore,
} from "../../../src/tool-runtime/internal/dispatch/staging-store";

export interface StagingStoreHarness {
  readonly store: StagingStore;
  /** Mint an owning run this adapter's rows can reference. */
  seedRun(status: RunStatus, fenceGeneration?: number): Promise<{ userId: string; runId: string }>;
  /** Out-of-band decision write — models the approval API, which is not the store's job. */
  decide(
    stagingId: string,
    decision: {
      status: ActionStagingStatus;
      decidedInput?: unknown;
      rejectReason?: string | null;
      decidedAt?: Date;
    },
  ): Promise<void>;
  /** Read the stored row back, including columns `StagingRow` does not carry. */
  readBack(stagingId: string): Promise<{
    status: ActionStagingStatus;
    outcome: EffectOutcome;
    effectKey: string;
    attemptKey: string;
    requestHash: string;
    rowVersion: number;
    decidedInput: unknown;
    executeResult: unknown;
    executeSanitized: boolean;
    executeError: unknown;
    executedAt: Date | null;
    displayInput: unknown;
  } | null>;
  /** A run id this adapter is certain has no row. */
  unknownRunId(): string;
}

let seq = 0;
function uniqueSuffix(): string {
  seq += 1;
  return `${Date.now().toString(36)}${seq}`;
}

function stagingValues(
  base: { userId: string; runId: string },
  overrides: Partial<StagingInsertValues> = {},
): StagingInsertValues {
  return {
    userId: base.userId,
    runId: base.runId,
    stepId: "dispatch-tools",
    toolCallId: `tc_${uniqueSuffix()}`,
    toolName: "system.load_tool",
    integration: "system",
    riskTier: "no_risk",
    proposedInput: { slug: "github" },
    displayInput: { slug: "github" },
    proposedInputHash: `hash_${uniqueSuffix()}`,
    requestHash: `req_${uniqueSuffix()}`,
    requiresApproval: false,
    status: "pending",
    ...overrides,
  };
}

/**
 * @param label how this adapter shows up in test output
 * @param harness returns the adapter under test plus its seeding/read-back
 *   seams. A thunk, not a value, so a suite whose harness only exists after a
 *   `before()` hook can still register its tests at module load. It must return
 *   the SAME store on every call — the tests share state within a test.
 * @param opts `skip` mirrors node:test's — `false`, or a string reason
 */
export function runStagingStoreContract(
  label: string,
  harness: () => StagingStoreHarness,
  opts: { skip?: boolean | string } = {},
): void {
  describe(`StagingStore contract — ${label}`, { skip: opts.skip ?? false }, () => {
    test("readRunStatus returns the owning run's status", async () => {
      const h = harness();
      const { runId } = await h.seedRun("running");
      assert.equal(await h.store.readRunStatus(runId), "running");
    });

    test("readRunStatus returns null for a run that does not exist", async () => {
      const h = harness();
      assert.equal(await h.store.readRunStatus(h.unknownRunId()), null);
    });

    test("#559b: readCancellationFence is total and reads the run's current generation", async () => {
      const h = harness();
      const { runId } = await h.seedRun("running", 3);
      assert.deepEqual(await h.store.readCancellationFence(runId), { generation: 3 });
      assert.deepEqual(
        await h.store.readCancellationFence(h.unknownRunId()),
        { generation: 0 },
        "an absent run reads as generation 0 — not-cancelled",
      );
    });

    test("upsertStaging inserts once and reports the conflict thereafter", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const values = stagingValues(run);

      const first = await h.store.upsertStaging(values);
      assert.equal(first.wasInserted, true, "first upsert is a genuine insert");
      assert.equal(first.row.status, "pending");
      assert.equal(first.row.runId, run.runId);

      const second = await h.store.upsertStaging(values);
      assert.equal(second.wasInserted, false, "re-upsert on the same key is not an insert");
      assert.equal(second.row.id, first.row.id, "conflict returns the existing row, not a new one");
    });

    test("a conflicting upsert returns the STORED row and clobbers no decision column", async () => {
      // This is what the resume path rests on: the gate re-sends `status:
      // "pending"` plus the original proposed input, and must read back the
      // approval the user made in between.
      const h = harness();
      const run = await h.seedRun("running");
      const values = stagingValues(run);
      const { row } = await h.store.upsertStaging(values);

      await h.decide(row.id, { status: "approved", decidedInput: { slug: "edited" } });

      const conflicted = await h.store.upsertStaging(values);
      assert.equal(conflicted.wasInserted, false);
      assert.equal(conflicted.row.status, "approved", "the conflict must not revert status");
      assert.deepEqual(
        conflicted.row.decidedInput,
        { slug: "edited" },
        "the conflict must not clobber decided_input",
      );
      assert.deepEqual(
        conflicted.row.proposedInput,
        { slug: "github" },
        "the conflict must not rewrite proposed_input from the re-sent values",
      );
    });

    test("promotePendingApproval raises only a pending autonomous row", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(
        stagingValues(run, { riskTier: "medium", requiresApproval: false }),
      );
      const notifyAfterAt = new Date("2026-08-11T10:00:00.000Z");
      const expiresAt = new Date("2026-08-12T10:00:00.000Z");

      const promoted = await h.store.promotePendingApproval(row.id, {
        riskTier: "high",
        proposedInput: { slug: "calendar" },
        displayInput: { slug: "calendar", credential: "[REDACTED]" },
        proposedInputHash: "hash_promoted",
        notifyAfterAt,
        expiresAt,
      });

      assert.equal(promoted?.riskTier, "high");
      assert.equal(promoted?.requiresApproval, true);
      assert.deepEqual(promoted?.proposedInput, { slug: "calendar" });
      assert.equal(promoted?.proposedInputHash, "hash_promoted");
      assert.deepEqual(promoted?.notifyAfterAt, notifyAfterAt);
      assert.deepEqual(promoted?.expiresAt, expiresAt);
      // #374: the promotion rewrites the input pair together — raw for resume,
      // redacted for display. Read back through the harness because
      // `StagingRow` (the store's gate-facing view) does not carry it.
      const promotedBack = await h.readBack(row.id);
      assert.deepEqual(
        promotedBack?.displayInput,
        { slug: "calendar", credential: "[REDACTED]" },
        "promotion persists the redacted display projection",
      );
      assert.equal(
        await h.store.promotePendingApproval(row.id, {
          riskTier: "high",
          proposedInput: { slug: "calendar" },
          displayInput: { slug: "calendar", credential: "[REDACTED]" },
          proposedInputHash: "hash_promoted",
          notifyAfterAt,
          expiresAt,
        }),
        null,
        "promotion is monotonic and cannot rewrite an already-gated row",
      );
    });

    test("findPriorRejection returns null when nothing matches", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const values = stagingValues(run);
      await h.store.upsertStaging(values);

      assert.equal(
        await h.store.findPriorRejection({
          runId: run.runId,
          toolName: "system.load_tool",
          proposedInputHash: values.proposedInputHash,
        }),
        null,
        "a pending row is not a prior rejection",
      );
    });

    test("findPriorRejection matches only on run + tool + hash, and only when rejected", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const other = await h.seedRun("running");
      const hash = `hash_${uniqueSuffix()}`;

      const rejected = await h.store.upsertStaging(stagingValues(run, { proposedInputHash: hash }));
      await h.decide(rejected.row.id, { status: "rejected", rejectReason: "nope" });

      // Same hash, different run.
      const otherRun = await h.store.upsertStaging(
        stagingValues(other, { proposedInputHash: hash }),
      );
      await h.decide(otherRun.row.id, { status: "rejected", rejectReason: "other run" });
      // Same run + hash, different tool.
      const otherTool = await h.store.upsertStaging(
        stagingValues(run, { proposedInputHash: hash, toolName: "system.spawn_sub_agent" }),
      );
      await h.decide(otherTool.row.id, { status: "rejected", rejectReason: "other tool" });

      assert.deepEqual(
        await h.store.findPriorRejection({
          runId: run.runId,
          toolName: "system.load_tool",
          proposedInputHash: hash,
        }),
        { reason: "nope" },
      );
      assert.equal(
        await h.store.findPriorRejection({
          runId: run.runId,
          toolName: "system.load_tool",
          proposedInputHash: `${hash}-different`,
        }),
        null,
        "a different input hash is a different proposal",
      );
    });

    test("findPriorRejection returns the MOST RECENT rejection", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const hash = `hash_${uniqueSuffix()}`;

      const older = await h.store.upsertStaging(stagingValues(run, { proposedInputHash: hash }));
      await h.decide(older.row.id, {
        status: "rejected",
        rejectReason: "older",
        decidedAt: new Date(Date.now() - 60_000),
      });
      const newer = await h.store.upsertStaging(stagingValues(run, { proposedInputHash: hash }));
      await h.decide(newer.row.id, {
        status: "rejected",
        rejectReason: "newer",
        decidedAt: new Date(),
      });

      assert.deepEqual(
        await h.store.findPriorRejection({
          runId: run.runId,
          toolName: "system.load_tool",
          proposedInputHash: hash,
        }),
        { reason: "newer" },
      );
    });

    test("findPriorRejection surfaces a null reason rather than inventing one", async () => {
      // The gate's `?? "rejected by user"` default is the gate's decision, not
      // the store's. A store that substituted a default here would move that
      // decision somewhere nobody reviews it.
      const h = harness();
      const run = await h.seedRun("running");
      const values = stagingValues(run);
      const { row } = await h.store.upsertStaging(values);
      await h.decide(row.id, { status: "rejected", rejectReason: null });

      assert.deepEqual(
        await h.store.findPriorRejection({
          runId: run.runId,
          toolName: "system.load_tool",
          proposedInputHash: values.proposedInputHash,
        }),
        { reason: null },
      );
    });

    test("commitStaging failed writes only its arm's columns and bumps row_version", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(stagingValues(run));
      const seeded = await h.readBack(row.id);
      const executedAt = new Date();
      const error = {
        code: "tool_execution_failed",
        message: "The tool failed unexpectedly. Please try again.",
      } as const;

      await h.store.commitStaging(row.id, row, {
        status: "failed",
        outcome: "failed",
        error,
        executedAt,
      });

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "failed");
      assert.equal(stored?.outcome, "failed", "the failed arm records the failed outcome");
      assert.deepEqual(stored?.executeError, error);
      assert.equal(stored?.executedAt?.getTime(), executedAt.getTime());
      assert.equal(stored?.executeResult, null, "the failed arm writes no result");
      assert.equal(stored?.executeSanitized, false, "the failed arm writes no sanitize verdict");
      assert.equal(
        stored?.rowVersion,
        (seeded?.rowVersion ?? 0) + 1,
        "a commit bumps row_version exactly once",
      );
    });

    test("commitStaging executed persists the result and the sanitize verdict", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(stagingValues(run));
      const seeded = await h.readBack(row.id);
      const executedAt = new Date();

      await h.store.commitStaging(row.id, row, {
        status: "executed",
        outcome: "succeeded",
        result: { ok: true },
        sanitized: true,
        executedAt,
      });

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "executed");
      assert.equal(stored?.outcome, "succeeded", "an executed row declares its outcome");
      assert.deepEqual(stored?.executeResult, { ok: true });
      assert.equal(
        stored?.executeSanitized,
        true,
        "the verdict must survive so the idempotent replay can re-emit the notice",
      );
      assert.equal(stored?.executeError, null, "the executed arm writes no error");
      assert.equal(stored?.rowVersion, (seeded?.rowVersion ?? 0) + 1);
    });

    test("commitStaging executed stores an undefined result as null, not as absent", async () => {
      // `status = 'executed'` is the discriminator for "execution happened".
      // A tool that legitimately returns nothing must not read back as
      // "no result yet".
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(stagingValues(run));

      await h.store.commitStaging(row.id, row, {
        status: "executed",
        outcome: "succeeded",
        result: undefined,
        sanitized: false,
        executedAt: new Date(),
      });

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "executed");
      assert.equal(stored?.executeResult, null);
    });

    test("commitStaging cannot overwrite a row advanced after it was observed", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(stagingValues(run));

      assert.equal(
        await h.store.commitStaging(row.id, row, {
          status: "executed",
          outcome: "succeeded",
          result: { ok: true },
          sanitized: false,
          executedAt: new Date(),
        }),
        true,
      );
      assert.equal(
        await h.store.commitStaging(row.id, row, {
          status: "executed",
          outcome: "unknown",
          result: { status: "unknown" },
          sanitized: false,
          executedAt: new Date(),
        }),
        false,
        "the stale expected state must lose to the aggregate settlement",
      );

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "executed");
      assert.equal(stored?.outcome, "succeeded");
      assert.deepEqual(stored?.executeResult, { ok: true });
    });

    test("upsertStaging honours a non-default status and requiresApproval on insert", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(
        stagingValues(run, { status: "approved", requiresApproval: true }),
      );
      assert.equal(row.status, "approved");
      assert.equal(row.requiresApproval, true);
      assert.equal(row.executeSanitized, false, "a fresh row is not sanitized");
      assert.equal(row.decidedInput, null);
    });

    test("#559a: the store mints a stable effect identity that survives re-dispatch", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const values = stagingValues(run);
      const first = await h.store.upsertStaging(values);

      assert.equal(first.row.effectKey, `eff:${run.runId}:${values.toolCallId}`);
      assert.equal(first.row.attemptKey, `eff:${run.runId}:${values.toolCallId}:1`);
      assert.equal(first.row.requestHash, values.requestHash, "request_hash comes from the gate");

      const conflicted = await h.store.upsertStaging(values);
      assert.equal(conflicted.wasInserted, false);
      assert.equal(
        conflicted.row.effectKey,
        first.row.effectKey,
        "a re-dispatch never rotates the minted effect key",
      );
      assert.equal(
        conflicted.row.attemptKey,
        first.row.attemptKey,
        "a re-dispatch never rotates the minted attempt key",
      );
    });

    test("#559a: a fresh row's outcome follows the approval gate", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const autonomous = await h.store.upsertStaging(stagingValues(run));
      assert.equal(
        autonomous.row.outcome,
        "dispatching",
        "an autonomous insert is about to dispatch",
      );

      const gated = await h.store.upsertStaging(
        stagingValues(run, { requiresApproval: true, riskTier: "high" }),
      );
      assert.equal(gated.row.outcome, "awaiting_approval", "a gated insert parks in the queue");

      const stored = await h.readBack(autonomous.row.id);
      assert.equal(stored?.outcome, "dispatching", "the outcome is persisted, not ephemeral");
    });

    test("#559a: promotion moves an autonomous row to awaiting_approval", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const { row } = await h.store.upsertStaging(stagingValues(run));
      assert.equal(row.outcome, "dispatching");

      const promoted = await h.store.promotePendingApproval(row.id, {
        riskTier: "high",
        proposedInput: { slug: "calendar" },
        displayInput: { slug: "calendar" },
        proposedInputHash: "hash_promoted",
        notifyAfterAt: new Date(),
        expiresAt: new Date(),
      });
      assert.equal(promoted?.outcome, "awaiting_approval");
      const stored = await h.readBack(row.id);
      assert.equal(stored?.outcome, "awaiting_approval");
    });

    test("#559a: findUnresolvedUnknown returns null when nothing is unresolved", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      await h.store.upsertStaging(stagingValues(run));

      assert.equal(
        await h.store.findUnresolvedUnknown({ userId: run.userId, requestHash: "req_any" }),
        null,
        "a dispatching row is not an unresolved unknown",
      );
    });

    test("#559a: findUnresolvedUnknown finds a row committed as unknown", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const values = stagingValues(run);
      const { row } = await h.store.upsertStaging(values);

      await h.store.commitStaging(row.id, row, {
        status: "executed",
        outcome: "unknown",
        result: { status: "unknown", retry: "blocked", message: "may have landed" },
        sanitized: false,
        executedAt: new Date(),
      });

      const found = await h.store.findUnresolvedUnknown({
        userId: run.userId,
        requestHash: values.requestHash,
      });
      assert.ok(found, "the committed unknown row is the barrier");
      assert.equal(found.id, row.id);
      assert.equal(found.effectKey, row.effectKey);

      const stored = await h.readBack(row.id);
      assert.equal(stored?.outcome, "unknown", "the unknown outcome is persisted");
    });

    test("#559a: findUnresolvedUnknown is scoped to user and request hash", async () => {
      const h = harness();
      const run = await h.seedRun("running");
      const other = await h.seedRun("running");
      const values = stagingValues(run);
      const { row } = await h.store.upsertStaging(values);
      await h.store.commitStaging(row.id, row, {
        status: "executed",
        outcome: "unknown",
        result: null,
        sanitized: false,
        executedAt: new Date(),
      });

      assert.equal(
        await h.store.findUnresolvedUnknown({
          userId: other.userId,
          requestHash: values.requestHash,
        }),
        null,
        "another user's identical request is a different effect",
      );
      assert.equal(
        await h.store.findUnresolvedUnknown({
          userId: run.userId,
          requestHash: `${values.requestHash}-different`,
        }),
        null,
        "the same user's different request is a different effect",
      );
    });
  });
}
