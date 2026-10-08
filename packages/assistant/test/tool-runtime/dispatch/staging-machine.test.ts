/**
 * The dispatch gate's staging state machine, run DB-free over the memory store.
 * For a non-passthrough `system.*` tool with `args.timezone` set, the store is the
 * gate's only Postgres dependency. `resolveApprovalNotifyDelayMs` is the exception,
 * so the approval-floor case primes the policy cache.
 * This is only evidence because `staging-store-contract.ts` also runs against Postgres.
 */

import assert from "node:assert/strict";
import { publicAppError } from "@alfred/contracts/app-errors";
import { afterEach, beforeEach, describe, test } from "node:test";

import { z } from "zod";
import {
  hashToolInput,
  hashToolRequest,
  isUnknownEffectEnvelope,
  jsonValueSchema,
  parseIanaTimezone,
  unknownEffectEnvelopeSchema,
  type IntegrationAvailabilitySnapshot,
} from "@alfred/contracts";

import {
  _setDispatchTraceSinksForTests,
  _setIntegrationAvailabilityReaderForTests,
  dispatchToolCall,
  toolCallWouldGate,
} from "../../../src/tool-runtime/internal/dispatch";
import { _setStagingStoreForTests } from "../../../src/tool-runtime/internal/dispatch/staging-store";
import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "@alfred/assistant/action-policies";
import {
  _primePolicyCacheForTests,
  clearPolicyCacheForTests,
} from "@alfred/assistant/action-policies/test-support";
import { clearToolRegistryForTests, liveTool, registerTool } from "@alfred/assistant/tool-runtime";
import { calendarTools } from "../../../src/tool-runtime/internal/tools/calendar";
import { registerReplicachePokeAdapter } from "@alfred/assistant/realtime";
import { memoryStagingStore, type MemoryStagingStore } from "./memory-staging-store";
import { runStagingStoreContract, type StagingStoreHarness } from "./staging-store-contract";

const USER_ID = "usr_staging_machine";

const RUN_ID = "run_staging_machine";

/** Without this, the gate reads the `"timezone"` pref from the DB. */
const TIMEZONE = parseIanaTimezone("UTC");

let store: MemoryStagingStore;

let restoreStore: (() => void) | null = null;

let restoreTraceSinks: (() => void) | null = null;

let restoreAvailabilityReader: (() => void) | null = null;

let unregisterPokeAdapter: (() => void) | null = null;

let executeCount = 0;

let lastExecutedInput: unknown;

function requireCalendarCreateEventTool() {
  const tool = calendarTools.find((candidate) => candidate.name === "calendar.create_event");

  if (!tool) throw new Error("production Calendar registration must include create_event");

  return tool;
}

const calendarCreateEventTool = requireCalendarCreateEventTool();

const calendarCredentialRequirement = (() => {
  const requirement = calendarCreateEventTool.availability?.credential;

  if (!requirement) {
    throw new Error("production Calendar create_event must declare its credential requirement");
  }

  return requirement;
})();

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    stepId: "dispatch-tools",
    toolCallId: "tc_default",
    toolName: "system.load_tool" as const,
    activeTools: [
      "system.load_tool",
      "system.spawn_sub_agent",
      "system.fetch_url",
      "calendar.create_event",
    ] as const,
    input: { slug: "github" },
    userId: USER_ID,
    caller: "boss" as const,
    runContext: { caller: "boss", interaction: "background" } as const,
    timezone: TIMEZONE,
    fence: { generation: 0 },
    ...overrides,
  };
}

function registerDoubles(): void {
  clearToolRegistryForTests();
  registerTool(
    liveTool({
      integration: "system",
      action: "load_tool",
      riskTier: "no_risk",
      description: "test double — counts executions",
      inputSchema: z.object({ slug: z.string(), optional: z.string().optional() }),
      execute: async (input) => {
        executeCount += 1;
        lastExecutedInput = input;

        if (input.slug === "boom") throw new Error("tool blew up");

        // A NUL the sanitizer must strip (ADR-0070 §1.1). Keep the `\x00` escape: a literal NUL
        // makes git treat the file as binary.
        if (input.slug === "poison") return { ok: true, note: "tail\x00end", call: executeCount };

        if (input.slug === "json-normalization") {
          return {
            at: new Date("2026-08-10T00:00:00.000Z"),
            omitted: undefined,
            items: [undefined, "kept"],
          };
        }

        return { ok: true, slug: input.slug, call: executeCount };
      },
    }),
  );
  registerTool(
    liveTool({
      integration: "system",
      action: "spawn_sub_agent",
      riskTier: "no_risk",
      description: "test double — should never execute here",
      inputSchema: z.object({}).passthrough(),
      execute: async () => {
        throw new Error("spawn_sub_agent double should not have executed");
      },
    }),
  );
  // `system.*` is autonomous, so a gate here is the risk-tier floor alone (ADR-0069).
  // The redactor mirrors real fetch_url: a gated tool that carries a secret.
  registerTool(
    liveTool({
      integration: "system",
      action: "fetch_url",
      riskTier: "high",
      description: "test double — high tier, so the approval floor gates it",
      inputSchema: z.object({ url: z.string() }),
      execute: async (input) => {
        executeCount += 1;
        lastExecutedInput = input;

        return { ok: true, url: input.url };
      },
      redactInput: (input) => ({
        ...input,
        url: input.url.replace(/([?&](?:code|access_token|token)=)[^&#]*/gi, "$1[REDACTED]"),
      }),
    }),
  );
  registerTool({
    ...calendarCreateEventTool,
    execute: async (input) => {
      executeCount += 1;
      lastExecutedInput = input;

      return { ok: true };
    },
  });
}

function installMachineFixture(): void {
  store = memoryStagingStore();
  store.seedRun(RUN_ID, "running");
  restoreStore = _setStagingStoreForTests(store);
  // The real `startToolSpan` calls `serverEnv()`, which throws without an env.
  restoreTraceSinks = _setDispatchTraceSinksForTests({
    rejectionRecorder: () => {},
    toolSpanStarter: () => ({ success: () => {}, error: () => {} }),
  });

  const availability: IntegrationAvailabilitySnapshot = {
    integrations: new Map([["calendar", { health: "active", accountLabel: null }]]),
    providers: new Map([
      [
        calendarCredentialRequirement.provider,
        [
          {
            credentialId: "cred_calendar",
            accountId: "account_calendar",
            status: "active",
            scopes: new Set(calendarCredentialRequirement.anyOfScopes),
            installationId: null,
            accountLabel: null,
            metadata: {},
          },
        ],
      ],
    ]),
    passthroughEnabled: new Map(),
  };

  restoreAvailabilityReader = _setIntegrationAvailabilityReaderForTests(() =>
    Promise.resolve(availability),
  );
  unregisterPokeAdapter = registerReplicachePokeAdapter({
    emitReplicachePokes: () => {},
  });
  executeCount = 0;
  lastExecutedInput = undefined;
  registerDoubles();
  clearPolicyCacheForTests();
  _primePolicyCacheForTests({
    userId: USER_ID,
    defaultMode: "gated",
    integrationRules: {
      system: { mode: "autonomy" },
      calendar: { mode: "autonomy" },
    },
    approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
  });
}

function teardownMachineFixture(): void {
  restoreStore?.();
  restoreStore = null;
  restoreTraceSinks?.();
  restoreTraceSinks = null;
  restoreAvailabilityReader?.();
  restoreAvailabilityReader = null;
  unregisterPokeAdapter?.();
  unregisterPokeAdapter = null;
  clearToolRegistryForTests();
  clearPolicyCacheForTests();
}

describe("dispatch staging machine (DB-free)", () => {
  beforeEach(installMachineFixture);
  afterEach(teardownMachineFixture);

  test("an autonomous call executes and commits an executed row", async () => {
    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_exec" }));

    assert.equal(result.kind, "executed");
    assert.equal(executeCount, 1);
    const [row] = store.rows();
    assert.equal(row?.status, "executed");
    assert.equal(row?.requiresApproval, false);
    assert.deepEqual(row?.executeResult, { ok: true, slug: "github", call: 1 });
    assert.equal(row?.rowVersion, 2, "insert then commit");
  });

  test("a staged tool result is normalized before return and persistence", async () => {
    const result = await dispatchToolCall(
      baseArgs({ toolCallId: "tc_json", input: { slug: "json-normalization" } }),
    );

    const expected = {
      at: "2026-08-10T00:00:00.000Z",
      items: [null, "kept"],
    };

    assert.equal(result.kind, "executed");
    assert.deepEqual(result.kind === "executed" ? result.toolResult : undefined, expected);
    assert.deepEqual(store.rows()[0]?.executeResult, expected);
  });

  test("a non-JSON proposed input is rejected before a staging row is written", async () => {
    await assert.rejects(
      dispatchToolCall(
        baseArgs({
          toolCallId: "tc_non_json_input",
          input: { slug: "github", optional: undefined },
        }),
      ),
      /Invalid input/,
    );

    assert.equal(executeCount, 0);
    assert.equal(store.rows().length, 0);
  });

  test("re-dispatching an executed call replays the stored result without re-executing", async () => {
    const args = baseArgs({ toolCallId: "tc_replay" });
    const first = await dispatchToolCall(args);
    const second = await dispatchToolCall(args);

    assert.equal(executeCount, 1, "the executed arm must short-circuit, not re-run the tool");
    assert.equal(second.kind, "executed");
    assert.deepEqual(
      second.kind === "executed" ? second.toolResult : undefined,
      first.kind === "executed" ? first.toolResult : "different",
      "the replay serves the STORED result",
    );
    assert.equal(store.rows().length, 1, "one tool call id is one row");
  });

  test("the executed replay re-emits the persisted sanitize verdict", async () => {
    const args = baseArgs({ toolCallId: "tc_poison", input: { slug: "poison" } });
    const first = await dispatchToolCall(args);
    assert.equal(first.kind === "executed" ? first.sanitized : undefined, true);

    const second = await dispatchToolCall(args);
    assert.equal(
      second.kind === "executed" ? second.sanitized : undefined,
      true,
      "a scrubbed result must never read as pristine on a second look",
    );
    assert.equal(store.rows()[0]?.executeSanitized, true, "the verdict is on the row");
  });

  test("a thrown tool commits a failed row carrying only the public error", async () => {
    const result = await dispatchToolCall(
      baseArgs({ toolCallId: "tc_boom", input: { slug: "boom" } }),
    );

    assert.equal(result.kind, "failed");
    const [row] = store.rows();
    assert.equal(row?.status, "failed");
    assert.deepEqual(row?.executeError, publicAppError("tool_execution_failed"));
    assert.equal(row?.executeResult, null, "a failed commit writes no result");
  });

  test("re-dispatching a failed call returns the stored error without re-executing", async () => {
    const args = baseArgs({ toolCallId: "tc_failed_replay", input: { slug: "boom" } });
    await dispatchToolCall(args);
    const second = await dispatchToolCall(args);

    assert.equal(executeCount, 1);
    assert.equal(second.kind, "failed");
    assert.deepEqual(
      second.kind === "failed" ? second.error : undefined,
      publicAppError("tool_execution_failed"),
    );
  });

  test("retry suppression synthesizes the prior rejection and writes NO new row", async () => {
    await dispatchToolCall(baseArgs({ toolCallId: "tc_first" }));
    store.decide(store.rows()[0]!.id, { status: "rejected", rejectReason: "not this one" });

    const rowsBefore = store.rows().length;
    // A new tool call id with the same input hashes the same.
    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_retry" }));

    assert.equal(result.kind, "rejected");
    assert.equal(result.stagingId, null, "a suppressed retry has no row of its own");
    assert.deepEqual(result.kind === "rejected" ? result.result : undefined, {
      status: "rejected_by_user",
      toolName: "system.load_tool",
      proposedInput: { slug: "github" },
      reason: "not this one",
      retryPolicy: "do_not_retry_identical",
    });
    assert.equal(store.rows().length, rowsBefore, "retry suppression must not write a row");
  });

  test("retry suppression does not fire for different input", async () => {
    await dispatchToolCall(baseArgs({ toolCallId: "tc_a" }));
    store.decide(store.rows()[0]!.id, { status: "rejected", rejectReason: "no" });

    const result = await dispatchToolCall(
      baseArgs({ toolCallId: "tc_b", input: { slug: "calendar" } }),
    );

    assert.equal(result.kind, "executed", "a different proposal is a different decision");
  });

  test("a terminal run is cancelled at the gate before any row is written", async () => {
    store.seedRun(RUN_ID, "cancelled");

    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_cancelled" }));

    assert.equal(result.kind, "rejected");
    assert.equal(result.stagingId, null);
    assert.match(
      result.kind === "rejected" ? JSON.stringify(result.result) : "",
      /run is already cancelled/,
    );
    assert.equal(store.rows().length, 0, "a cancelled run must not stage");
    assert.equal(executeCount, 0);
  });

  test("#559b: a step whose fence moved past its capture refuses before staging", async () => {
    // The step holds generation 0 but the store holds 1, so the run was cancelled mid-step.
    // Status stays `running`, so only the fence can refuse. No row, approval, or effect.
    store.seedRun(RUN_ID, "running", { generation: 1 });

    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_fenced" }));

    assert.equal(result.kind, "fenced");
    assert.equal(result.stagingId, null);
    assert.match(
      result.kind === "fenced" ? JSON.stringify(result.result) : "",
      /run was cancelled while this call was pending/,
    );
    assert.equal(store.rows().length, 0, "a fenced run must not stage");
    assert.equal(executeCount, 0);
  });

  test("#559b: an equal fence passes the gate", async () => {
    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_fence_ok" }));

    assert.equal(result.kind, "executed");
    assert.equal(executeCount, 1);
  });

  test("#559b: a cancel landing mid-dispatch is refused immediately before the effect", async () => {
    // A cancel lands after the gate's fence read and before the effect.
    // Only the pre-execute re-read can refuse. The written row must close `failed`, not stay
    // `pending`.
    const upsert = store.upsertStaging;
    store.upsertStaging = async (values) => {
      const result = await upsert(values);
      store.seedRun(RUN_ID, "running", { generation: 1 });

      return result;
    };

    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_late_fence" }));

    assert.equal(result.kind, "fenced");
    assert.equal(executeCount, 0, "the effect must not fire after a mid-dispatch cancel");
    const [row] = store.rows();
    assert.ok(row, "the upsert already wrote the row before the cancel landed");
    assert.equal(result.kind === "fenced" ? result.stagingId : null, row.id);
    assert.equal(row.status, "failed");
    assert.equal(
      row.outcome,
      "refused",
      "a refusal is not an attempted effect, so it is not `failed`",
    );
    assert.deepEqual(row.executeError, publicAppError("run_cancelled"));
  });

  test("an unknown run reads as unavailable rather than executing", async () => {
    const result = await dispatchToolCall(
      baseArgs({ toolCallId: "tc_no_run", runId: "run_never_seeded" }),
    );

    assert.equal(result.kind, "rejected");
    assert.match(
      result.kind === "rejected" ? JSON.stringify(result.result) : "",
      /run is unavailable/,
    );
    assert.equal(executeCount, 0);
  });

  test("the high-tier approval floor stages and parks on a hil wake", async () => {
    const result = await dispatchToolCall(
      baseArgs({
        toolCallId: "tc_gated",
        toolName: "system.fetch_url",
        input: { url: "https://example.test" },
      }),
    );

    assert.equal(result.kind, "staged", "a `high`-tier tool always confirms, even under autonomy");
    assert.equal(executeCount, 0, "a staged call must not execute");
    assert.deepEqual(result.kind === "staged" ? result.wake : undefined, {
      kind: "hil",
      approvalId: result.stagingId,
      approvalKind: "action_staging",
      prompt: "Approve system.fetch_url",
    });
    const [row] = store.rows();
    assert.equal(row?.status, "pending");
    assert.equal(row?.requiresApproval, true);
    assert.ok(row?.expiresAt instanceof Date, "a gated row gets a hard expiry");
  });

  test("#374: a gated secret-bearing tool stages raw input for resume, redacted for display", async () => {
    const result = await dispatchToolCall(
      baseArgs({
        toolCallId: "tc_gated_secret",
        toolName: "system.fetch_url",
        input: { url: "https://example.test/cb?code=topsecret42&page=2" },
      }),
    );

    assert.equal(result.kind, "staged", "the high-tier floor gates it");
    assert.equal(executeCount, 0, "a staged call must not execute");

    const [row] = store.rows();
    // A gated call keeps `proposed_input` raw: it is the resume payload.
    const proposed = row?.proposedInput as { url?: string } | undefined;
    assert.match(proposed?.url ?? "", /code=topsecret42/, "resume needs the real credential");
    // The approval email reads `display_input`, so that one is scrubbed.
    const display = row?.displayInput as { url?: string } | undefined;
    assert.match(display?.url ?? "", /code=\[REDACTED\]/, "display projection is scrubbed");
    assert.match(display?.url ?? "", /page=2/, "non-credential params survive redaction");
    assert.doesNotMatch(JSON.stringify(display), /topsecret42/, "no secret in display_input");
  });

  test("a Calendar event without attendees stays medium and executes under autonomy", async () => {
    const input = {
      summary: "Focus block",
      start: "2026-08-12T10:00:00+05:30",
      end: "2026-08-12T11:00:00+05:30",
      attendees: [],
    };

    const result = await dispatchToolCall(
      baseArgs({
        toolCallId: "tc_calendar_no_attendees",
        toolName: "calendar.create_event",
        input,
      }),
    );

    assert.equal(result.kind, "executed");
    assert.equal(executeCount, 1);
    const [row] = store.rows();
    assert.equal(row?.riskTier, "medium");
    assert.equal(row?.requiresApproval, false);
    assert.deepEqual(lastExecutedInput, { calendarId: "primary", ...input });
  });

  test("the live-chat hint keeps dynamic Calendar risk in the serial approval lane", async () => {
    assert.equal(await toolCallWouldGate(USER_ID, "calendar.create_event"), true);
  });

  test("a Calendar invite becomes high, stages, and resumes with every attendee", async () => {
    const attendees = ["ada@example.com", "grace@example.com"];

    const input = {
      summary: "Planning",
      start: "2026-08-12T10:00:00+05:30",
      end: "2026-08-12T11:00:00+05:30",
      attendees,
    };

    const args = baseArgs({
      toolCallId: "tc_calendar_invite",
      toolName: "calendar.create_event",
      input,
    });

    const staged = await dispatchToolCall(args);
    assert.equal(staged.kind, "staged", "an invite must park even under autonomy");
    assert.equal(executeCount, 0);
    const [row] = store.rows();
    assert.equal(row?.riskTier, "high");
    assert.equal(row?.requiresApproval, true);
    assert.deepEqual(row?.proposedInput, {
      calendarId: "primary",
      ...input,
    });

    store.decide(row!.id, { status: "approved" });
    const resumed = await dispatchToolCall(args);
    assert.equal(resumed.kind, "executed");
    assert.equal(executeCount, 1);
    assert.deepEqual(lastExecutedInput, {
      calendarId: "primary",
      ...input,
    });
  });

  test("a pending pre-floor Calendar invite is promoted to approval before resume", async () => {
    const toolCallId = "tc_calendar_invite_before_floor";

    const input = calendarCreateEventTool.inputSchema.parse({
      summary: "Legacy planning",
      start: "2026-08-12T10:00:00+05:30",
      end: "2026-08-12T11:00:00+05:30",
      attendees: ["ada@example.com"],
    });

    await store.upsertStaging({
      userId: USER_ID,
      runId: RUN_ID,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "calendar.create_event",
      integration: "calendar",
      riskTier: "medium",
      proposedInput: jsonValueSchema.parse(input),
      displayInput: jsonValueSchema.parse(input),
      proposedInputHash: hashToolInput("calendar.create_event", input),
      requestHash: hashToolRequest("calendar.create_event", input, undefined),
      requiresApproval: false,
      status: "pending",
    });

    const result = await dispatchToolCall(
      baseArgs({
        toolCallId,
        toolName: "calendar.create_event",
        input,
      }),
    );

    assert.equal(result.kind, "staged", "the new high-risk floor must dominate the old row");
    assert.equal(executeCount, 0, "an old autonomous row must not execute the invite");
    const [row] = store.rows();
    assert.equal(row?.riskTier, "high");
    assert.equal(row?.requiresApproval, true);
  });

  test("a policy change does not promote a pending medium-risk autonomous row", async () => {
    const toolCallId = "tc_calendar_policy_change";

    const input = calendarCreateEventTool.inputSchema.parse({
      summary: "Focus block",
      start: "2026-08-12T10:00:00+05:30",
      end: "2026-08-12T11:00:00+05:30",
      attendees: [],
    });

    await store.upsertStaging({
      userId: USER_ID,
      runId: RUN_ID,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "calendar.create_event",
      integration: "calendar",
      riskTier: "medium",
      proposedInput: jsonValueSchema.parse(input),
      displayInput: jsonValueSchema.parse(input),
      proposedInputHash: hashToolInput("calendar.create_event", input),
      requestHash: hashToolRequest("calendar.create_event", input, undefined),
      requiresApproval: false,
      status: "pending",
    });
    clearPolicyCacheForTests();
    _primePolicyCacheForTests({
      userId: USER_ID,
      defaultMode: "gated",
      integrationRules: { calendar: { mode: "gated" } },
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    });

    const result = await dispatchToolCall(
      baseArgs({
        toolCallId,
        toolName: "calendar.create_event",
        input,
      }),
    );

    assert.equal(result.kind, "executed", "a later policy change applies only to fresh calls");
    assert.equal(executeCount, 1);
    assert.equal(store.rows()[0]?.requiresApproval, false);
  });

  test("a pending gated row stays gated when the policy flips to autonomy mid-run", async () => {
    // The stored `requires_approval` is locked in (ADR-0034). A policy toggle must not run an
    // in-flight call.
    const args = baseArgs({
      toolCallId: "tc_sticky",
      toolName: "system.fetch_url",
      input: { url: "https://example.test" },
    });

    await dispatchToolCall(args);
    const second = await dispatchToolCall(args);

    assert.equal(second.kind, "staged");
    assert.equal(executeCount, 0);
  });

  test("resume on an approved row executes the row's proposed input, not the re-dispatched one", async () => {
    const args = baseArgs({ toolCallId: "tc_resume" });
    await dispatchToolCall({ ...args, input: { slug: "github" } });
    const [row] = store.rows();
    store.decide(row!.id, { status: "approved" });

    // A mutated payload must not slip past the gate through resume.
    const result = await dispatchToolCall({ ...args, input: { slug: "smuggled" } });

    assert.equal(result.kind, "executed");
    assert.deepEqual(lastExecutedInput, { slug: "github" }, "resume runs the APPROVED input");
  });

  test("resume with a user-edited input runs the edit and flags editedByUser", async () => {
    const args = baseArgs({ toolCallId: "tc_edited" });
    await dispatchToolCall(args);
    store.decide(store.rows()[0]!.id, { status: "approved", decidedInput: { slug: "edited" } });

    const result = await dispatchToolCall(args);

    assert.equal(result.kind, "executed");
    assert.equal(result.kind === "executed" ? result.editedByUser : undefined, true);
    assert.deepEqual(lastExecutedInput, { slug: "edited" });
  });

  test("resume re-validation turns a schema-violating edit into a failed row, unexecuted", async () => {
    const args = baseArgs({ toolCallId: "tc_bad_edit" });
    await dispatchToolCall(args);
    const before = executeCount;
    store.decide(store.rows()[0]!.id, {
      status: "approved",
      decidedInput: { slug: 42, secret: "edited-private-value" },
    });

    const result = await dispatchToolCall(args);

    assert.deepEqual(result, {
      kind: "failed",
      stagingId: store.rows()[0]!.id,
      error: publicAppError("tool_input_invalid"),
    });
    assert.equal(executeCount, before, "an invalid edit must never reach the tool");
    const stored = store.readBack(store.rows()[0]!.id);
    assert.equal(stored?.status, "failed");
    assert.doesNotMatch(
      JSON.stringify(stored?.executeError),
      /edited-private-value/,
      "the rejected payload must not leak into the persisted error",
    );
  });

  test("the rejected STATUS ARM answers when the input hash has moved on", async () => {
    // Not retry suppression: the input hashes differently, so the status machine answers
    // (non-null stagingId).
    const args = baseArgs({ toolCallId: "tc_rejected_row" });
    await dispatchToolCall(args);
    const rowId = store.rows()[0]!.id;
    store.decide(rowId, { status: "rejected", rejectReason: "user said no" });

    const result = await dispatchToolCall({ ...args, input: { slug: "different" } });

    assert.equal(result.kind, "rejected");
    assert.equal(result.stagingId, rowId, "the status arm answers off the existing row");
    assert.match(result.kind === "rejected" ? JSON.stringify(result.result) : "", /user said no/);
    assert.equal(executeCount, 1, "only the first, pre-rejection dispatch executed");
  });

  test("an expired row reports auto-expired", async () => {
    const args = baseArgs({ toolCallId: "tc_expired" });
    await dispatchToolCall(args);
    store.decide(store.rows()[0]!.id, { status: "expired" });

    const result = await dispatchToolCall(args);

    assert.equal(result.kind, "rejected");
    assert.match(result.kind === "rejected" ? JSON.stringify(result.result) : "", /auto-expired/);
  });

  test("re-dispatching a toolCallId under a different toolName fails loud", async () => {
    const toolCallId = "tc_mismatch";
    await dispatchToolCall(baseArgs({ toolCallId }));

    await assert.rejects(
      dispatchToolCall(baseArgs({ toolCallId, toolName: "system.spawn_sub_agent", input: {} })),
      /toolName mismatch on re-dispatch/,
    );
  });

  test("a fresh toolCallId in the same run is a distinct call", async () => {
    await dispatchToolCall(baseArgs({ toolCallId: "tc_one" }));
    await dispatchToolCall(baseArgs({ toolCallId: "tc_two", input: { slug: "calendar" } }));
    assert.equal(executeCount, 2);
    assert.equal(store.rows().length, 2);
  });

  test("an unresolved unknown effect blocks an identical request with no new row", async () => {
    // An identical request after an unconfirmed effect is blocked before a row exists,
    // so fresh toolCallIds cannot replay it. The seed stands in for an MCP `unknown`.
    const args = baseArgs({ toolCallId: "tc_seed_unknown" });

    const { row } = await store.upsertStaging({
      userId: USER_ID,
      runId: RUN_ID,
      stepId: args.stepId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      integration: "system",
      riskTier: "no_risk",
      proposedInput: jsonValueSchema.parse(args.input),
      displayInput: jsonValueSchema.parse(args.input),
      proposedInputHash: hashToolInput(args.toolName, args.input),
      requestHash: hashToolRequest(args.toolName, args.input, undefined),
      requiresApproval: false,
      status: "pending",
    });

    await store.commitStaging(row.id, row, {
      status: "executed",
      outcome: "unknown",
      result: unknownEffectEnvelopeSchema.parse({
        status: "unknown",
        retry: "blocked",
        message: "ambiguous delivery",
      }),
      sanitized: false,
      executedAt: new Date(),
    });

    const result = await dispatchToolCall(baseArgs({ toolCallId: "tc_identical_replay" }));

    assert.equal(result.kind, "blocked", "an unresolved identical effect is blocked");

    if (result.kind !== "blocked") return;
    assert.equal(result.stagingId, null, "the barrier fires before any row exists");
    assert.equal(
      isUnknownEffectEnvelope(result.result),
      true,
      "the model sees the unknown envelope",
    );
    assert.equal(executeCount, 0, "a blocked request must never reach the tool");
    assert.equal(store.rows().length, 1, "the blocked request writes no new staging row");
  });

  test("a tool returning an unknown envelope commits unknown and blocks the replay", async () => {
    // An unknown-envelope result persists `outcome: "unknown"`, and the next identical request
    // trips the barrier.
    clearToolRegistryForTests();
    registerTool(
      liveTool({
        integration: "system",
        action: "load_tool",
        riskTier: "no_risk",
        description: "test double — ambiguous delivery",
        inputSchema: z.object({ slug: z.string() }),
        execute: async () => {
          executeCount += 1;

          return unknownEffectEnvelopeSchema.parse({
            status: "unknown",
            retry: "blocked",
            message: "ambiguous delivery",
          });
        },
      }),
    );

    const first = await dispatchToolCall(baseArgs({ toolCallId: "tc_ambiguous" }));
    assert.equal(first.kind, "executed", "the envelope still completes the tool call");
    const [stored] = store.rows();
    assert.equal(stored?.outcome, "unknown", "an ambiguous execution commits the unknown outcome");

    const replay = await dispatchToolCall(baseArgs({ toolCallId: "tc_ambiguous_replay" }));
    assert.equal(replay.kind, "blocked", "a replay of an unresolved unknown effect is blocked");
    assert.equal(executeCount, 1, "the replay must not execute");
    assert.equal(store.rows().length, 1, "the blocked replay writes no row");
  });

  // Not tested: the `default:` status arm. `parseStagingRow` rejects an unknown status first,
  // so only the fake could reach it.
});

/** Memory half of the store contract. The Postgres half runs in `staging.test.ts`. */
const contractStore = memoryStagingStore();

let contractRunSeq = 0;

runStagingStoreContract("memory", (): StagingStoreHarness => {
  const active = contractStore;

  return {
    store: active,
    async seedRun(status, fenceGeneration) {
      contractRunSeq += 1;
      const runId = `run_contract_${contractRunSeq}`;
      active.seedRun(runId, status, { generation: fenceGeneration ?? 0 });

      return { userId: `usr_contract_${contractRunSeq}`, runId };
    },
    async decide(stagingId, decision) {
      active.decide(stagingId, decision);
    },
    async readBack(stagingId) {
      const row = active.readBack(stagingId);

      return row
        ? {
            status: row.status,
            outcome: row.outcome,
            effectKey: row.effectKey,
            attemptKey: row.attemptKey,
            requestHash: row.requestHash,
            rowVersion: row.rowVersion,
            decidedInput: row.decidedInput,
            executeResult: row.executeResult,
            executeSanitized: row.executeSanitized,
            executeError: row.executeError,
            executedAt: row.executedAt,
            displayInput: row.displayInput,
          }
        : null;
    },
    unknownRunId() {
      return "run_contract_never_seeded";
    },
  };
});
