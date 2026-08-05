import { Elysia, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { closeAgentQueue, enqueueRun } from "./queue";
import { isInternalWorkflowSlug, listPublicWorkflows, registerRecipe } from "./registry";
import {
  cancelRun,
  createRun,
  getRun,
  replayRun,
  signalRun,
  signalRunInTx,
  startRun,
  startRunInTx,
  type SignalArgs,
} from "./service";
import { isUniqueViolation } from "../../lib/pg-errors";
import { closeSubAgentJoinWakeQueue } from "./sub-agent-join-wake-queue";
import {
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
} from "./sub-agent-join-wake-worker";
import { verifyMeteringModels } from "./verify-models";
import { startAgentWorker, stopAgentWorker } from "./worker";
import { Errors, toMessage } from "@alfred/contracts";

export {
  registerRecipe,
  createRun,
  startRun,
  startRunInTx,
  getRun,
  signalRun,
  signalRunInTx,
  cancelRun,
  enqueueRun,
  startAgentWorker,
  stopAgentWorker,
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
  verifyMeteringModels,
};
// The execution-domain verb for "hand an already-persisted run to the worker":
// re-delivery (approvals), a best-effort kick after a committed larger write
// (chat-turn), or after an interleaved domain write (skills). Same function as
// the raw `enqueueRun` queue primitive; the distinct public name lets product
// modules express intent instead of importing the queue primitive directly.
export { enqueueRun as deliverRun } from "./queue";
export { closeAgentQueue, closeSubAgentJoinWakeQueue };
export type {
  RunStatus,
  Step,
  StepContext,
  StepResult,
  WakeCondition,
  Workflow,
  WorkflowInput,
} from "./types";
export type { CancelOutcome, SignalOutcome } from "./service";

// Agent-runtime primitives the `conversations` chat recipe reaches through this
// public seam. The recipe lives in `conversations`; execution never imports it,
// so it consumes these turn/sub-agent/context helpers here rather than through
// private module paths.
//
// `run-compaction` exposes the generic `<run_summary>` token/window math the
// chat compaction files in `conversations/compaction` still share (ADR-0035);
// `grounding`, `instructions`, `connected-summary`, and `transcript-dedup` are
// permanent shared agent-runtime services — the sub-agent executor
// (`workflows/user-authored-brief.ts`) consumes them too, so they stay in
// `agent`. Chat context assembly, chat summaries, and chat compaction now live
// in `conversations/compaction` and are no longer reachable here.
export {
  CHARS_PER_TOKEN,
  compactTranscript,
  compactWithRetry,
  estimateSerializedTokens,
  estimateTranscriptTokens,
} from "./run-compaction";
export { buildConnectedSummaryFromAvailability } from "./connected-summary";
export {
  formatRuntimeTimeGrounding,
  resolveRuntimeGroundingAnchor,
  resolveUserTimezone,
} from "./grounding";
export { composeAgentInstructions } from "./instructions";
export {
  foldToolSurfaceState,
  systemToolKernel,
  toolRuntimeForRun,
  toolSurfaceStateFields,
} from "./tool-surface";
export { appendModelResponseMessages } from "./transcript-dedup";
export { aggregateRunUsage } from "./usage-fold";
export { createVoiceStreamSanitizer, sanitizeVoice } from "./voice-sanitize";
export {
  shouldPublishToolStarted,
  toolCardStarted,
  toolCardTerminal,
} from "./workflows/tool-card-events";
export { toolEventOutcome } from "./workflows/tool-event-outcome";
export { pendingToolCallSchema } from "./workflows/pending-tool-call";
export {
  CHAT_TURN_CAP_MAX,
  openChatTurnRetries,
  resetChatTurnRetryBudgets,
} from "./workflows/turn-budgets";
export { PREVIEW_CHARS } from "./workflows/tool-preview";
export { joinChildRun, type JoinChildRunDeps, type ParkSignal } from "./sub-agent-join";
export { scheduleSubAgentJoinWakeJob } from "./sub-agent-join-wake-queue";
export {
  isTerminalChildStatus,
  listSpawnedChildRuns,
  readChildRunOutcome,
  type ChildRunOutcome,
} from "./sub-agents";
export type { AgentDbExecutor } from "./types";

export const agent = new Elysia({ prefix: "/api/agent", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/workflows", () => {
        return {
          workflows: listPublicWorkflows().map((w) => ({
            slug: w.slug,
            description: w.description,
            initialStep: w.initialStep,
          })),
        };
      })
      .post(
        "/runs",
        async ({ body, user }) => {
          if (isInternalWorkflowSlug(body.workflowSlug)) {
            throw Errors.NotFoundError("Workflow not found");
          }
          try {
            const { runId } = await startRun({
              userId: user.id,
              workflowSlug: body.workflowSlug,
              brief: body.brief,
              input: body.input,
              metadata: body.metadata,
              // /api/agent/runs is the generic "Run now" surface. Cron
              // and event dispatchers go through their own paths; an
              // HTTP-initiated run is always manual per ADR-0027.
              trigger: { kind: "manual" },
              occurrence: {
                kind: "manual",
                requestId: body.requestId,
              },
            });
            return { runId };
          } catch (err) {
            // Workflows that declare a `dedupKey` use a partial unique
            // index to enforce singleton semantics; a duplicate trips
            // Postgres 23505 here. Surface that as 409 so callers can
            // distinguish "already running / already done" from a real
            // 4xx — the raw constraint name is unhelpful to clients.
            if (isUniqueViolation(err)) {
              throw Errors.ConflictError(
                `An active run for workflow "${body.workflowSlug}" already exists.`,
              );
            }
            const msg = toMessage(err);
            throw Errors.BadRequestError(msg);
          }
        },
        {
          body: t.Object({
            workflowSlug: t.String({ minLength: 1, maxLength: 120 }),
            requestId: t.String({ minLength: 1, maxLength: 200 }),
            brief: t.Optional(t.String({ maxLength: 4_000 })),
            input: t.Optional(t.Unknown()),
            metadata: t.Optional(t.Record(t.String(), t.Unknown())),
          }),
        },
      )
      .post(
        "/runs/:runId/replay",
        async ({ params, body, user }) => {
          const replayed = await replayRun({
            userId: user.id,
            runId: params.runId,
            requestId: body.requestId,
            revisionChoice: body.revisionChoice,
          });
          await enqueueRun(replayed.runId);
          return replayed;
        },
        {
          params: t.Object({ runId: t.String() }),
          body: t.Object({
            requestId: t.String({ minLength: 1, maxLength: 200 }),
            revisionChoice: t.Union([t.Literal("original"), t.Literal("latest")]),
          }),
        },
      )
      .get(
        "/runs/:runId",
        async ({ params, user }) => {
          const run = await getRun(params.runId, user.id);
          if (!run) throw Errors.NotFoundError("Run not found");
          return run;
        },
        { params: t.Object({ runId: t.String() }) },
      )
      .post(
        "/runs/:runId/signal",
        async ({ params, body, user }) => {
          const run = await getRun(params.runId, user.id);
          if (!run) throw Errors.NotFoundError("Run not found");
          // Reshape the flat body into the discriminated union that
          // `signalRun` consumes. `kind` is `t.String()` rather than a
          // literal-union because Elysia 1.4's `exact-mirror` validator
          // logs a noisy warning the first time it sees ANY `t.Union`
          // schema (even of literals) and falls through without
          // enforcing it — same end state, less log noise. The handler
          // narrows + validates instead.
          let match: SignalArgs["match"];
          if (body.match) {
            const kind = body.match.kind;
            if (kind === "hil") {
              if (!body.match.approvalId) {
                throw Errors.BadRequestError("match.kind='hil' requires approvalId");
              }
              match = {
                kind: "hil",
                approvalId: body.match.approvalId,
                ...(body.match.approvalKind === "step" ||
                body.match.approvalKind === "action_staging"
                  ? { approvalKind: body.match.approvalKind }
                  : {}),
              };
            } else if (kind === "signal") {
              if (!body.match.name) {
                throw Errors.BadRequestError("match.kind='signal' requires name");
              }
              match = { kind: "signal", name: body.match.name };
            } else if (kind === "any") {
              match = { kind: "any" };
            } else {
              throw Errors.BadRequestError(
                `match.kind must be 'hil' | 'signal' | 'any'; got ${String(kind)}`,
              );
            }
          }
          const woken = await signalRun({ runId: params.runId, match });
          if (!woken) throw Errors.ConflictError("Run not waiting on a matching condition");
          await enqueueRun(params.runId);
          return { ok: true };
        },
        {
          params: t.Object({ runId: t.String() }),
          body: t.Object({
            match: t.Optional(
              t.Object({
                kind: t.String({ minLength: 1, maxLength: 16 }),
                approvalId: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
                approvalKind: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
                name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
              }),
            ),
          }),
        },
      ),
  );
