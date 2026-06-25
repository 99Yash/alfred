/**
 * Tool dispatcher (m13 Phase 3 / ADR-0034).
 *
 * Every tool call the boss (or a sub-agent) makes flows through
 * `dispatchToolCall`. Responsibilities:
 *
 *   1. Resolve the tool registry entry and validate the proposed input.
 *   2. Stable-hash the input (`hashToolInput`) for retry suppression and
 *      duplicate detection.
 *   3. Consult `user_action_policies` (in-process cache, bust via Redis
 *      Pub/Sub) to decide autonomy vs. gated.
 *   4. INSERT `action_stagings` row, idempotent on
 *      `(run_id, tool_call_id)`. The row is the canonical audit + UI
 *      surface for every tool call regardless of mode.
 *   5. Autonomy: execute the tool, update the row with the result, hand
 *      the result back to the caller.
 *   6. Gated: return a `staged` outcome carrying a `WakeCondition`
 *      whose `approvalId` is the staging row id. The agent loop turns
 *      that into a `StepResult.interrupt` so the executor parks the
 *      run; the resume path (the same step re-runs after approval) hits
 *      this function again with the same `tool_call_id` and finds an
 *      `approved` (or `rejected` / `expired`) row to act on.
 *
 * The dispatcher is also the retry-suppression gate (Phase 3c). When a
 * model re-proposes a tool call with byte-identical input to one the
 * user already rejected, we synthesize `rejected_by_user` immediately —
 * no second staging row, no second email — and the boss learns by
 * receiving the result.
 *
 * The function is single-pass: it handles both the initial dispatch and
 * the post-approval resume by branching on the existing row's status.
 * Callers don't need a separate "resume" entry point.
 */

import type { IntegrationSlug, PolicyMode, ToolName, ToolRiskTier } from "@alfred/contracts";
import {
  APPROVAL_EXPIRY_MS,
  getPath,
  hashToolInput,
  INTEGRATION_ACTIONS,
  integrationFromToolName,
  isIntegrationSlug,
  isToolName,
  sanitizeErrorMessage,
  sanitizeToolResult,
  toMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings, type ActionStaging } from "@alfred/db/schemas";
import { actionStagingStatusSchema } from "@alfred/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import { emitReplicachePokes } from "../../events/replicache-events";
import { resolveApprovalNotifyDelayMs, resolvePolicyMode } from "../action-policies/resolve";
import type { WakeCondition } from "../agent/types";
import { scheduleApprovalExpiryJob } from "../approvals/expiry-queue";
import { scheduleApprovalNotificationJob } from "../approvals/notification-queue";
import { parseScratchToolKey, type ScratchToolKey } from "../tools/scratch-key";
import { getTool, type ToolExecuteContext } from "../tools/registry";
import { resolveUserTimezone } from "../user-timezone";

export interface DispatchArgs {
  runId: string;
  /** Logical executor step that owns this call — audit only. */
  stepId: string;
  /** Stable id from the model's tool call (deduplicates same call across step re-attempts). */
  toolCallId: string;
  toolName: string;
  input: unknown;
  userId: string;
  /** Who is calling — boss or named sub-agent. Threaded into the tool context. */
  caller?: ToolExecuteContext["caller"];
  /** Scratchpad namespace to use for system scratch tools. Defaults to `runId`. */
  scratchpadRunId?: string;
  /**
   * The user's IANA timezone, if the caller already has it (e.g. chat snapshots
   * it once per run). Omitted → the dispatcher reads the `"timezone"` pref.
   */
  timezone?: string;
  /** Workflow integration cap, used by system tools such as `system.load_integration`. */
  allowedIntegrations?: readonly string[];
}

interface RejectedToolResult {
  status: "rejected_by_user";
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
  /** Hint to the boss: same input verbatim will be auto-rejected again. */
  retryPolicy: "do_not_retry_identical";
}

interface InvalidInputToolResult {
  status: "invalid_input";
  toolName: ToolName;
  message: string;
  issues?: unknown;
}

interface UnknownToolResult {
  status: "unknown_tool";
  toolName: string;
  message: string;
}

export type DispatchResult =
  | {
      kind: "executed";
      stagingId: string | null;
      toolResult: unknown;
      /** True when the user edited the input before approving — the boss
       *  may want to surface that to the model so future suggestions
       *  account for the correction. */
      editedByUser: boolean;
      /** ADR-0070: set when the result carried persistence-poison (NUL /
       *  lone surrogates) that the dispatch-boundary sanitizer stripped. The
       *  flag rides on the envelope, never on the result value (a bare
       *  string/array result can't carry a property). */
      sanitized?: boolean;
    }
  | {
      kind: "failed";
      stagingId: string | null;
      error: { message: string };
    }
  | {
      kind: "rejected";
      /** `null` only on retry-suppression — no new row written. */
      stagingId: string | null;
      result: RejectedToolResult;
    }
  | {
      kind: "staged";
      stagingId: string;
      wake: Extract<WakeCondition, { kind: "hil" }>;
    }
  | {
      kind: "invalid_input";
      result: InvalidInputToolResult;
    }
  | {
      kind: "unknown_tool";
      result: UnknownToolResult;
    };

type StagingRow = Pick<
  ActionStaging,
  | "id"
  | "runId"
  | "status"
  | "requiresApproval"
  | "toolName"
  | "proposedInput"
  | "decidedInput"
  | "rejectReason"
  | "executeResult"
  | "executeError"
  | "notifyAfterAt"
  | "notifiedAt"
  | "expiresAt"
>;

const STAGING_COLUMNS = {
  id: actionStagings.id,
  runId: actionStagings.runId,
  status: actionStagings.status,
  requiresApproval: actionStagings.requiresApproval,
  toolName: actionStagings.toolName,
  proposedInput: actionStagings.proposedInput,
  decidedInput: actionStagings.decidedInput,
  rejectReason: actionStagings.rejectReason,
  executeResult: actionStagings.executeResult,
  executeError: actionStagings.executeError,
  notifyAfterAt: actionStagings.notifyAfterAt,
  notifiedAt: actionStagings.notifiedAt,
  expiresAt: actionStagings.expiresAt,
} as const;

function parseStagingRow(row: StagingRow): StagingRow {
  return { ...row, status: actionStagingStatusSchema.parse(row.status) };
}

export async function dispatchToolCall(args: DispatchArgs): Promise<DispatchResult> {
  if (!isToolName(args.toolName)) {
    return {
      kind: "unknown_tool",
      result: {
        status: "unknown_tool",
        toolName: args.toolName,
        message: undeclaredToolMessage(args.toolName, args.allowedIntegrations),
      },
    };
  }

  const toolName = args.toolName;
  const tool = getTool(toolName);
  if (!tool) {
    return {
      kind: "unknown_tool",
      result: {
        status: "unknown_tool",
        toolName,
        message: `Tool '${toolName}' is not registered`,
      },
    };
  }

  const parsed = tool.inputSchema.safeParse(args.input);
  if (!parsed.success) {
    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message: parsed.error.message,
        issues: parsed.error.issues,
      },
    };
  }
  const input = parsed.data as unknown;
  const caller = args.caller ?? "boss";
  const ctx: ToolExecuteContext = {
    runId: args.runId,
    scratchpadRunId: args.scratchpadRunId ?? args.runId,
    stepId: args.stepId,
    toolCallId: args.toolCallId,
    userId: args.userId,
    timezone: args.timezone ?? (await resolveUserTimezone(args.userId)),
    caller,
    allowedIntegrations: args.allowedIntegrations,
  };
  const scratchAccessError = validateScratchToolAccess({ toolName, input, caller });
  if (scratchAccessError) {
    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message: scratchAccessError,
      },
    };
  }
  const systemAccessError = validateSystemToolAccess({ toolName, caller });
  if (systemAccessError) {
    return {
      kind: "invalid_input",
      result: {
        status: "invalid_input",
        toolName,
        message: systemAccessError,
      },
    };
  }
  if (isScratchFastPathTool(toolName)) {
    return executeFastPath(tool, input, ctx);
  }

  const proposedInputHash = hashToolInput(toolName, input);

  // Retry suppression — Phase 3c. A prior `rejected` row for this run +
  // tool + input hash means the user has already said no to this exact
  // proposal; synthesize the same rejection without writing a new row
  // or firing a new notification. Limited to the same run because
  // ADR-0034 scopes the partial index that way.
  const priorReject = await db()
    .select({
      reason: actionStagings.rejectReason,
      decidedAt: actionStagings.decidedAt,
    })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.runId, args.runId),
        eq(actionStagings.toolName, toolName),
        eq(actionStagings.proposedInputHash, proposedInputHash),
        eq(actionStagings.status, "rejected"),
      ),
    )
    .orderBy(desc(actionStagings.decidedAt))
    .limit(1);

  if (priorReject[0]) {
    return {
      kind: "rejected",
      stagingId: null,
      result: synthesizeRejection({
        toolName,
        proposedInput: input,
        reason: priorReject[0].reason ?? "rejected by user",
      }),
    };
  }

  const integration: IntegrationSlug = integrationFromToolName(toolName);
  const riskTier: ToolRiskTier = tool.riskTier;
  const policyMode =
    integration === "system" ? "autonomy" : await resolvePolicyMode(args.userId, toolName);
  const requiresApproval = toolRequiresApproval(policyMode, riskTier);
  const approvalNotifyDelayMs = requiresApproval
    ? await resolveApprovalNotifyDelayMs(args.userId)
    : null;
  const notifyAfterAt =
    approvalNotifyDelayMs !== null ? new Date(Date.now() + approvalNotifyDelayMs) : null;
  // Gated rows get a hard expiry so an undecided approval can't park the
  // run forever (Phase 5e). The `staging-expire` worker fires at this
  // time and auto-rejects if still pending.
  const expiresAt = requiresApproval ? new Date(Date.now() + APPROVAL_EXPIRY_MS) : null;

  // Single upsert. On a `(run_id, tool_call_id)` conflict we do a *no-op*
  // UPDATE purely so the existing row is RETURNED — `onConflictDoNothing`
  // returns nothing on conflict, which previously forced a second SELECT-back
  // round-trip. The no-op set MUST NOT touch any decision/result column: a
  // re-dispatch of an already-staged/approved/executed call has to read the
  // stored row verbatim (the resume path below depends on it). `xmax = 0`
  // distinguishes a freshly-inserted row from an updated (conflict) one — the
  // standard Postgres upsert idiom — so the Replicache poke stays gated to
  // genuinely-new rows.
  const upserted = await db()
    .insert(actionStagings)
    .values({
      userId: args.userId,
      runId: args.runId,
      stepId: args.stepId,
      toolCallId: args.toolCallId,
      toolName,
      integration,
      riskTier,
      proposedInput: input as object,
      proposedInputHash,
      requiresApproval,
      status: "pending",
      notifyAfterAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [actionStagings.runId, actionStagings.toolCallId],
      set: { rowVersion: sql`${actionStagings.rowVersion}` },
    })
    .returning({ ...STAGING_COLUMNS, wasInserted: sql<boolean>`xmax = 0` });

  const upsertedRow = upserted[0];
  if (!upsertedRow) {
    throw new Error(
      `[dispatch] action_stagings upsert returned no row (run=${args.runId}, toolCallId=${args.toolCallId})`,
    );
  }
  const { wasInserted, ...rowColumns } = upsertedRow;
  const insertedNew = wasInserted;
  const row: StagingRow = parseStagingRow(rowColumns);
  // Defensive: the (run_id, tool_call_id) unique index says one tool call id
  // maps to one row. If a caller re-dispatches the same id with a different
  // `toolName`, the model emitted two tools under the same call id — a
  // programming/model bug, not a dispatcher policy decision. Fail loud rather
  // than silently executing the new tool while updating the original row's
  // audit trail. (No-op on a fresh insert: the stored toolName equals the
  // dispatched one.)
  if (row.toolName !== toolName) {
    throw new Error(
      `[dispatch] toolName mismatch on re-dispatch (run=${args.runId}, toolCallId=${args.toolCallId}, stored='${row.toolName}', got='${toolName}')`,
    );
  }
  switch (row.status) {
    case "pending":
      // Honor the `requires_approval` recorded on the row, NOT the
      // freshly-resolved policy. If the user changed their integration
      // mode after the row was inserted (e.g. gated → autonomy), the
      // pending row should still respect the decision that was active
      // when it was staged — otherwise a policy toggle would silently
      // auto-execute every in-flight gated call. Policy changes apply
      // to the next dispatched tool call; once staged, a row's gate
      // sticks. Mirrors the plan's intent that `requires_approval` is
      // the locked-in decision per ADR-0034.
      if (row.requiresApproval) {
        // Park. The executor emits the transient `approval.requested`
        // event when it commits the interrupt; Replicache carries the
        // durable approvals queue. Emit the poke only for a newly-created
        // row so crash/resume re-dispatches don't spam connected clients.
        if (insertedNew) emitReplicachePokes([args.userId], row.id);
        if (!row.notifiedAt) {
          const delayMs =
            row.notifyAfterAt instanceof Date
              ? row.notifyAfterAt.getTime() - Date.now()
              : (approvalNotifyDelayMs ?? 0);
          await scheduleApprovalNotificationJob({
            stagingId: row.id,
            userId: args.userId,
            delayMs,
          });
        }
        // Schedule the hard-expiry fallback. Idempotent on the
        // deterministic job id, so a crash/resume re-dispatch of the same
        // staged call won't double-schedule. Delay derives from the
        // row's stored `expires_at` so the timer survives restarts.
        {
          const expiryDelayMs =
            row.expiresAt instanceof Date
              ? row.expiresAt.getTime() - Date.now()
              : APPROVAL_EXPIRY_MS;
          await scheduleApprovalExpiryJob({
            stagingId: row.id,
            userId: args.userId,
            delayMs: expiryDelayMs,
          });
        }
        return {
          kind: "staged",
          stagingId: row.id,
          wake: {
            kind: "hil",
            approvalId: row.id,
            approvalKind: "action_staging",
            prompt: `Approve ${toolName}`,
          },
        };
      }
      return executeAndCommit(row, tool, input, ctx, /* editedByUser */ false);

    case "approved": {
      // Resume after user approval — execute with the decided input if
      // they edited it, otherwise with the originally-proposed input
      // STORED on the row. Never use `args.input` here: the user
      // approved the row's `proposed_input`, not whatever the caller
      // re-supplied on this dispatch. A caller that re-dispatches with
      // a mutated payload should not be able to slip an unapproved
      // input past the gate via the resume path.
      const editedByUser = row.decidedInput !== null && row.decidedInput !== undefined;
      const useInput = editedByUser ? row.decidedInput : row.proposedInput;
      // Re-validate so an edited payload that violates the schema
      // becomes a failed row rather than a thrown executor. The
      // originally-proposed input was already validated on insert; the
      // decided input came from the user via the approval API and may
      // not have been validated there.
      const reparsed = tool.inputSchema.safeParse(useInput);
      if (!reparsed.success) {
        const now = new Date();
        await db()
          .update(actionStagings)
          .set({
            status: "failed",
            executeError: { message: reparsed.error.message, issues: reparsed.error.issues },
            executedAt: now,
            rowVersion: sql`${actionStagings.rowVersion} + 1`,
          })
          .where(eq(actionStagings.id, row.id));
        if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
        return {
          kind: "failed",
          stagingId: row.id,
          error: { message: reparsed.error.message },
        };
      }
      return executeAndCommit(row, tool, reparsed.data as unknown, ctx, editedByUser);
    }

    case "rejected":
      return {
        kind: "rejected",
        stagingId: row.id,
        result: synthesizeRejection({
          toolName,
          proposedInput: input,
          reason: row.rejectReason ?? "rejected by user",
        }),
      };

    case "expired":
      return {
        kind: "rejected",
        stagingId: row.id,
        result: synthesizeRejection({
          toolName,
          proposedInput: input,
          reason: "auto-expired",
        }),
      };

    case "executed":
      // Idempotent re-dispatch. The model proposed the same tool call
      // again (step re-attempt) and the row already carries the
      // result — hand it straight back without re-executing.
      return {
        kind: "executed",
        stagingId: row.id,
        toolResult: row.executeResult,
        editedByUser: row.decidedInput !== null && row.decidedInput !== undefined,
      };

    case "failed":
      return {
        kind: "failed",
        stagingId: row.id,
        error: extractStoredError(row.executeError),
      };

    default:
      // Unknown statuses surface as a failure rather than throwing —
      // the agent loop turns them into a tool result the boss can
      // reason about.
      return {
        kind: "failed",
        stagingId: row.id,
        error: { message: `dispatcher saw unexpected staging status '${row.status}'` },
      };
  }
}

/**
 * Whether a tool call must be staged for human approval. Two independent
 * triggers, OR'd:
 *
 *   1. The user's policy resolves to `gated` (tool override → integration mode
 *      → user default, per ADR-0034).
 *   2. A risk-tier floor: a `high`-tier tool ALWAYS confirms, regardless of
 *      policy. The global "Auto" autonomy toggle is a chat-convenience control
 *      (stop nagging me about reads); it must not silently authorize the
 *      handful of genuinely-irreversible actions (send a real email, redeploy a
 *      service — including a shared team workspace). riskTier was previously a
 *      display-only hint (registry.ts header); this makes `high` load-bearing
 *      for the gate. Amends ADR-0034 — see decisions.md.
 *
 * Keep this the single definition of the gate so the live dispatch path and the
 * `toolCallWouldGate` scheduling hint can never drift apart.
 */
export function toolRequiresApproval(policyMode: PolicyMode, riskTier: ToolRiskTier): boolean {
  return policyMode === "gated" || riskTier === "high";
}

/**
 * Best-effort prediction of whether a *fresh* dispatch of this tool would gate
 * (stage for approval) instead of executing autonomously. Mirrors the policy +
 * risk-tier gate in {@link dispatchToolCall}: `system.*` is always autonomy,
 * everything else follows the user's (cached) policy mode OR the high-tier
 * floor.
 *
 * This is a scheduling hint, not a correctness gate — `dispatchToolCall` stays
 * the source of truth and still honors the row's stored `requires_approval` on
 * resume. Batch callers use it to avoid staging more than one gated write at
 * once: gated writes only *stage* during dispatch (the real work runs after
 * approval), so parallelizing them buys no latency while breaking the HIL
 * contract (the run parks on a single `approvalId`; sibling approval cards 409
 * on `wake_mismatch` and each fires its own email).
 */
export async function toolCallWouldGate(userId: string, toolName: string): Promise<boolean> {
  if (!isToolName(toolName)) return false;
  if (integrationFromToolName(toolName) === "system") return false;
  const policyMode = await resolvePolicyMode(userId, toolName);
  const riskTier = getTool(toolName)?.riskTier ?? "no_risk";
  return toolRequiresApproval(policyMode, riskTier);
}

export function undeclaredToolMessage(
  toolName: string,
  allowedIntegrations: readonly string[] = [],
): string {
  const suggestion = integrationActionSuggestion(toolName, allowedIntegrations);
  if (!suggestion) return `Tool '${toolName}' is not declared`;

  const validActions =
    suggestion.validActions.length > 0
      ? `${suggestion.integration} exposes: ${suggestion.validActions.map((action) => `\`${action}\``).join(", ")}.`
      : `${suggestion.integration} exposes no callable actions yet.`;
  const retry =
    suggestion.toolName === null
      ? null
      : suggestion.inputWasQualified
        ? `Use '${suggestion.toolName}' instead.`
        : `Integration tools use qualified names like '${suggestion.toolName}'.`;
  return [
    `Tool '${toolName}' is not declared.`,
    validActions,
    retry,
    `Call system.load_integration with slug '${suggestion.integration}' first if that integration is not active,`,
    suggestion.toolName === null ? null : `then retry '${suggestion.toolName}'.`,
    "Do not ask the user just to load an integration.",
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function integrationActionSuggestion(
  input: string,
  allowedIntegrations: readonly string[],
): {
  integration: IntegrationSlug;
  toolName: ToolName | null;
  validActions: readonly string[];
  inputWasQualified: boolean;
} | null {
  const qualified = parseQualifiedToolName(input);
  if (qualified) {
    const { integration, action } = qualified;
    if (integration === "system") return null;
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(integration)) {
      return null;
    }
    const actions: readonly string[] = INTEGRATION_ACTIONS[integration];
    const closest = closestAction(action, actions);
    const toolName = closest ? toolNameForAction(integration, closest) : null;
    return { integration, toolName, validActions: actions, inputWasQualified: true };
  }

  const matches = (Object.keys(INTEGRATION_ACTIONS) as IntegrationSlug[]).filter((integration) => {
    if (integration === "system") return false;
    if (allowedIntegrations.length > 0 && !allowedIntegrations.includes(integration)) {
      return false;
    }
    const actions: readonly string[] = INTEGRATION_ACTIONS[integration];
    return actions.includes(input);
  });
  if (matches.length !== 1) return null;

  const integration = matches[0];
  if (!integration) return null;
  const toolName = toolNameForAction(integration, input);
  if (!toolName) return null;
  return {
    integration,
    toolName,
    validActions: INTEGRATION_ACTIONS[integration],
    inputWasQualified: false,
  };
}

function parseQualifiedToolName(
  toolName: string,
): { integration: IntegrationSlug; action: string } | null {
  const separator = toolName.indexOf(".");
  if (separator <= 0 || separator !== toolName.lastIndexOf(".")) return null;
  const integration = toolName.slice(0, separator);
  if (!isIntegrationSlug(integration)) return null;
  const action = toolName.slice(separator + 1);
  if (!action) return null;
  return { integration, action };
}

function toolNameForAction(integration: IntegrationSlug, action: string): ToolName | null {
  const name = `${integration}.${action}`;
  return isToolName(name) ? name : null;
}

function closestAction(input: string, actions: readonly string[]): string | null {
  if (actions.length === 0) return null;
  if (actions.includes(input)) return input;
  if (actions.length === 1) return actions[0] ?? null;

  const inputTokens = actionTokens(input);
  let best: { action: string; score: number } | null = null;
  for (const action of actions) {
    const actionTokenSet = new Set(actionTokens(action));
    const common = inputTokens.filter((token) => actionTokenSet.has(token)).length;
    const substring = action.includes(input) || input.includes(action) ? 1 : 0;
    const score = common * 10 + substring * 5 - Math.abs(action.length - input.length) / 10;
    if (!best || score > best.score) best = { action, score };
  }

  return best && best.score > 0 ? best.action : null;
}

function actionTokens(action: string): string[] {
  return action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

async function executeAndCommit(
  row: StagingRow,
  tool: ReturnType<typeof getTool> & object,
  input: unknown,
  ctx: ToolExecuteContext,
  editedByUser: boolean,
): Promise<DispatchResult> {
  let result: unknown;
  let error: { message: string } | undefined;
  try {
    result = await tool.execute(input, ctx);
  } catch (err) {
    // Throw-poison class (ADR-0070 §1.3): a tool that *throws* a NUL-byte
    // message. The result-boundary sanitizer below can't reach this — a throw
    // carries no result — so strip the error string before it hits the
    // `execute_error` jsonb write.
    error = { message: sanitizeErrorMessage(toMessage(err)) };
  }
  const now = new Date();
  if (error) {
    await db()
      .update(actionStagings)
      .set({
        status: "failed",
        executeError: error,
        executedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(eq(actionStagings.id, row.id));
    if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
    return { kind: "failed", stagingId: row.id, error };
  }
  // ADR-0070 §1.1: sanitize at the dispatch boundary, the instant the tool
  // returns and before the value touches any persisted sink. This cleans the
  // `execute_result` jsonb write below AND the `toolResult` returned to the
  // caller (which flows into the transcript/state — the same poison sinks).
  const sanitizedResult = sanitizeToolResult(result);
  result = sanitizedResult.value;
  const didSanitize = sanitizedResult.removed > 0 || sanitizedResult.collisions > 0;
  if (didSanitize) {
    console.warn(
      `[dispatch] sanitized ${sanitizedResult.removed} poison code unit(s)` +
        `${sanitizedResult.collisions > 0 ? `, ${sanitizedResult.collisions} key collision(s)` : ""}` +
        ` from ${tool.name} result`,
    );
  }
  // A tool legitimately returning `null` or `undefined` is stored as
  // SQL NULL in `execute_result`. The `status='executed'` field is the
  // discriminator for "execution happened" — readers should never infer
  // "no result yet" from a null payload. The single-threaded-per-run
  // executor model (one worker holds the lease) is what guarantees no
  // other process can interleave a status flip between the
  // `tool.execute` above and this UPDATE; if that invariant ever
  // changes, add `AND status IN ('pending', 'approved')` here.
  await db()
    .update(actionStagings)
    .set({
      status: "executed",
      executeResult: (result === undefined ? null : result) as object | null,
      executedAt: now,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
    })
    .where(eq(actionStagings.id, row.id));
  if (row.requiresApproval) emitReplicachePokes([ctx.userId], row.id);
  return {
    kind: "executed",
    stagingId: row.id,
    toolResult: result,
    editedByUser,
    sanitized: didSanitize,
  };
}

async function executeFastPath(
  tool: ReturnType<typeof getTool> & object,
  input: unknown,
  ctx: ToolExecuteContext,
): Promise<DispatchResult> {
  try {
    const result = await tool.execute(input, ctx);
    // ADR-0070 §1.1: sanitize at the boundary even on the fast path — this
    // result flows into the transcript/state just like the staged path.
    const sanitized = sanitizeToolResult(result);
    const didSanitize = sanitized.removed > 0 || sanitized.collisions > 0;
    if (didSanitize) {
      console.warn(
        `[dispatch] sanitized ${sanitized.removed} poison code unit(s)` +
          `${sanitized.collisions > 0 ? `, ${sanitized.collisions} key collision(s)` : ""}` +
          ` from ${tool.name} result`,
      );
    }
    return {
      kind: "executed",
      stagingId: null,
      toolResult: sanitized.value,
      editedByUser: false,
      sanitized: didSanitize,
    };
  } catch (err) {
    // Throw-poison class (ADR-0070 §1.3).
    return {
      kind: "failed",
      stagingId: null,
      error: { message: sanitizeErrorMessage(toMessage(err)) },
    };
  }
}

interface SynthesizeRejectionArgs {
  toolName: ToolName;
  proposedInput: unknown;
  reason: string;
}

function synthesizeRejection(args: SynthesizeRejectionArgs): RejectedToolResult {
  return {
    status: "rejected_by_user",
    toolName: args.toolName,
    proposedInput: args.proposedInput,
    reason: args.reason,
    retryPolicy: "do_not_retry_identical",
  };
}

function extractStoredError(stored: unknown): { message: string } {
  if (stored && typeof stored === "object" && "message" in stored) {
    const message = (stored as { message: unknown }).message;
    return { message: typeof message === "string" ? message : JSON.stringify(message) };
  }
  return { message: stored ? JSON.stringify(stored) : "unknown failure" };
}

function validateScratchToolAccess(args: {
  toolName: ToolName;
  input: unknown;
  caller: ToolExecuteContext["caller"];
}): string | null {
  if (args.toolName === "system.read_scratch") {
    const key = readStringProp(args.input, "key");
    const target = parseScratchAccessKey(key);
    if (typeof target === "string") return target;
    if (args.caller !== "boss" && target.zone === "scratch" && target.subId !== args.caller.subId) {
      return `Sub-agent '${args.caller.subId}' cannot read scratch for '${target.subId}'`;
    }
    return null;
  }

  if (args.toolName === "system.write_scratch") {
    const key = readStringProp(args.input, "key");
    const target = parseScratchAccessKey(key);
    if (typeof target === "string") return target;
    if (args.caller === "boss") {
      return target.zone === "shared" ? null : "Boss can only write shared.<path> scratch keys";
    }
    return target.zone === "scratch" && target.subId === args.caller.subId
      ? null
      : `Sub-agent '${args.caller.subId}' can only write scratch.${args.caller.subId}.<path> keys`;
  }

  if (args.toolName === "system.promote") {
    if (args.caller !== "boss") return "system.promote can only be called by the boss";
    const from = parseScratchAccessKey(readStringProp(args.input, "fromKey"));
    if (typeof from === "string") return from;
    const to = parseScratchAccessKey(readStringProp(args.input, "toKey"));
    if (typeof to === "string") return to;
    if (from.zone !== "scratch") return "system.promote fromKey must be scratch.<subId>.<path>";
    if (to.zone !== "shared") return "system.promote toKey must be shared.<path>";
    return null;
  }

  return null;
}

function isScratchFastPathTool(toolName: ToolName): boolean {
  return (
    toolName === "system.read_scratch" ||
    toolName === "system.write_scratch" ||
    toolName === "system.promote"
  );
}

function validateSystemToolAccess(args: {
  toolName: ToolName;
  caller: ToolExecuteContext["caller"];
}): string | null {
  if (args.toolName === "system.spawn_sub_agent" && args.caller !== "boss") {
    return "system.spawn_sub_agent can only be called by the boss";
  }
  return null;
}

function parseScratchAccessKey(key: string | null): ScratchToolKey | string {
  if (key === null) return "Scratch key must be a string";
  try {
    return parseScratchToolKey(key);
  } catch (err) {
    return toMessage(err);
  }
}

function readStringProp(input: unknown, prop: string): string | null {
  const value = getPath(input, prop);
  return typeof value === "string" ? value : null;
}
