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

import type { ActionStagingStatus, RunStatus } from "@alfred/contracts";
import type { NewActionStaging } from "@alfred/db/schemas";

import type { StagingStore } from "../../../src/tool-runtime/internal/dispatch/staging-store";

export interface StagingStoreHarness {
  readonly store: StagingStore;
  /** Mint an owning run this adapter's rows can reference. */
  seedRun(status: RunStatus): Promise<{ userId: string; runId: string }>;
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
    rowVersion: number;
    decidedInput: unknown;
    executeResult: unknown;
    executeSanitized: boolean;
    executeError: unknown;
    executedAt: Date | null;
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
  overrides: Partial<NewActionStaging> = {},
): NewActionStaging {
  return {
    userId: base.userId,
    runId: base.runId,
    stepId: "dispatch-tools",
    toolCallId: `tc_${uniqueSuffix()}`,
    toolName: "system.load_tool",
    integration: "system",
    riskTier: "no_risk",
    proposedInput: { slug: "github" },
    proposedInputHash: `hash_${uniqueSuffix()}`,
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
      assert.equal(
        await h.store.promotePendingApproval(row.id, {
          riskTier: "high",
          proposedInput: { slug: "calendar" },
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

      await h.store.commitStaging(row.id, { status: "failed", error, executedAt });

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "failed");
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

      await h.store.commitStaging(row.id, {
        status: "executed",
        result: { ok: true },
        sanitized: true,
        executedAt,
      });

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "executed");
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

      await h.store.commitStaging(row.id, {
        status: "executed",
        result: undefined,
        sanitized: false,
        executedAt: new Date(),
      });

      const stored = await h.readBack(row.id);
      assert.equal(stored?.status, "executed");
      assert.equal(stored?.executeResult, null);
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
  });
}
