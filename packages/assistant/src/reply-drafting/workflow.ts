import {
  replyDraftInvocationSchema,
  replyDraftStyleSelectionSchema,
  replyDraftTriageSnapshotSchema,
  toMessage,
  type ReplyDraftProvenance,
  type ReplyDraftResult,
  type ReplyDraftTriageSnapshot,
} from "@alfred/contracts";
import { z } from "zod";
import type { StepContext, StepResult, Workflow } from "@alfred/assistant/execution";
import { findActiveSenderSuppression } from "@alfred/assistant/knowledge";
import { getStyleProfile } from "@alfred/assistant/knowledge/style-profiles";
import { resolveFeatureFlags } from "@alfred/assistant/settings";
import {
  extractSenderContext,
  getThreadState,
  getTriage,
  loadTriageContext,
  recipientAddresses,
  type TriageRow,
} from "@alfred/assistant/triage";
import { checkGmailSendAccess } from "./access";
// Imported for its module augmentation: it registers the `reply_drafting.decision`
// trace kind that every `ctx.trace` call below is typed against.
import "./decision";
import { REPLY_DRAFTING_WORKFLOW_SLUG, replyDraftingWorkflowInputSchema } from "./workflow-input";
import {
  decideReplyWorthiness,
  noDraftResult,
  type ReplyStandingInstructionState,
} from "./worthiness";

/**
 * The `reply-drafting` workflow (ADR-0098): `gate` → `gather` → `compose`.
 *
 * `gate` re-runs the worthiness rubric on the live row so a run started by a
 * stale event (or by hand) decides from what is true now. `gather` proves the
 * mailbox can send, picks the style profile, and freezes the recipient and
 * participant facts the verifier will bind to. `compose` is a seam: at #243 it
 * returns `no_draft` with reason `composer_unavailable`; #237 replaces that step
 * body with the composer and the `prepareReplyStaging` → `stageAction` call.
 *
 * Every terminal step traces the result as `reply_drafting.decision` and returns
 * it as the run output, so a `no_draft`, `no_access`, or `withheld` run is a
 * completed run with a typed reason, never a failed one.
 */

const stateSchema = z.object({
  documentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  invocation: replyDraftInvocationSchema,
  triage: replyDraftTriageSnapshotSchema.nullable(),
  featureFlagEnabled: z.boolean().optional(),
  sender: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  mailbox: z.object({ accountId: z.string().min(1), address: z.string().nullable() }).optional(),
  threadParticipants: z.array(z.string()).optional(),
  recipients: z.object({ to: z.array(z.string()), cc: z.array(z.string()) }).optional(),
  style: replyDraftStyleSelectionSchema.optional(),
});
type State = z.infer<typeof stateSchema>;

/**
 * The live row as a snapshot. `email_triage.document_id` is a soft pointer that
 * survives a purge of the document it names, so a null falls back to the
 * document this run was started for.
 */
function snapshotFromRow(row: TriageRow, fallbackDocumentId: string): ReplyDraftTriageSnapshot {
  return {
    documentId: row.documentId ?? fallbackDocumentId,
    sourceThreadId: row.sourceThreadId,
    triageRunId: row.runId,
    category: row.category,
    confidence: row.confidence,
    model: row.model,
    todoDecision: row.todoDecision ?? null,
    senderRelationshipIsCold: row.senderRelationshipIsCold ?? null,
    senderSignificanceBand: row.senderSignificanceBand ?? null,
  };
}

function provenanceFor(state: State): ReplyDraftProvenance {
  return {
    invocation: state.invocation,
    featureFlagEnabled: state.featureFlagEnabled ?? false,
    triage: state.triage,
    inbound: {
      documentId: state.documentId,
      sourceThreadId: state.sourceThreadId,
      messageId: state.messageId ?? null,
    },
    sender: state.sender ?? null,
    recipients: state.recipients ?? { to: [], cc: [] },
    style: state.style ?? null,
    gatheredObjects: [],
    verifier: null,
  };
}

function finish(
  ctx: StepContext<State>,
  state: State,
  result: ReplyDraftResult,
): StepResult<State> {
  ctx.trace("reply_drafting.decision", result);
  return { kind: "done", state, output: result };
}

async function runGate(ctx: StepContext<State>): Promise<StepResult<State>> {
  const ctxData = await loadTriageContext(ctx.state.documentId, ctx.userId);
  if (!ctxData) {
    throw new Error(`[reply-drafting] document not found or not Gmail: ${ctx.state.documentId}`);
  }
  const flags = await resolveFeatureFlags(ctx.userId);
  const senderContextResult = extractSenderContext({
    fromHeader: ctxData.document.metadata.from ?? null,
    subject: ctxData.document.title,
    body: ctxData.document.content,
  });
  const row = await getTriage(ctx.userId, ctx.state.sourceThreadId);
  const triage = ctx.state.triage ?? (row ? snapshotFromRow(row, ctx.state.documentId) : null);
  const threadState = await getThreadState({
    userId: ctx.userId,
    sourceThreadId: ctx.state.sourceThreadId,
    excludeDocumentId: ctx.state.documentId,
  });

  let standingInstruction: ReplyStandingInstructionState = "none";
  try {
    const match = await findActiveSenderSuppression(ctx.userId, {
      senderEmail: senderContextResult.senderAddress,
      accountId: ctxData.document.accountId,
      effect: "block_reply_draft",
    });
    if (match) standingInstruction = "suppress";
  } catch (err) {
    standingInstruction = "read_failed";
    await ctx.log(`gate: standing instruction read failed: ${toMessage(err)}`);
  }

  const state: State = {
    ...ctx.state,
    triage,
    featureFlagEnabled: flags.replyDrafting,
    sender: senderContextResult.senderAddress,
    messageId: ctxData.document.sourceId,
    mailbox: { accountId: ctxData.document.accountId, address: ctxData.identity.mailboxAddress },
    threadParticipants: [
      ...recipientAddresses(ctxData.document.metadata.from),
      ...recipientAddresses(ctxData.document.metadata.to),
      ...recipientAddresses(ctxData.document.metadata.cc),
    ],
  };

  const shared = {
    featureFlagEnabled: flags.replyDrafting,
    sender: { effectiveAuthor: senderContextResult.context.effectiveAuthor },
    thread: {
      inboundAuthoredAt: ctxData.document.authoredAt,
      lastUserReplyAt: threadState.lastUserReplyAt,
    },
    // The run has no gmail.message_received reason of its own; the reply state
    // comes from the thread timestamps read above.
    triageReason: null,
    standingInstruction,
  };
  if (state.invocation === "post_triage" && !triage) {
    throw new Error(
      `[reply-drafting] post_triage run has no triage snapshot for thread=${state.sourceThreadId}`,
    );
  }
  const decision =
    state.invocation === "post_triage" && triage
      ? decideReplyWorthiness({ ...shared, invocation: "post_triage", triage })
      : decideReplyWorthiness({ ...shared, invocation: "manual", triage });

  if (!decision.worthy) {
    await ctx.log(`gate: no_draft reason=${decision.reason}`);
    return finish(ctx, state, noDraftResult(decision.reason, decision.note, provenanceFor(state)));
  }
  await ctx.log(`gate: worthy invocation=${state.invocation} sender=${state.sender ?? "?"}`);
  return { kind: "next", state, nextStep: "gather" };
}

async function runGather(ctx: StepContext<State>): Promise<StepResult<State>> {
  const mailbox = ctx.state.mailbox;
  if (!mailbox) throw new Error("[reply-drafting] gather entered without mailbox state");

  const access = await checkGmailSendAccess({ userId: ctx.userId, accountId: mailbox.accountId });
  if (!access.ok) {
    await ctx.log(`gather: no_access reason=${access.reason}`);
    return finish(ctx, ctx.state, {
      outcome: "no_access",
      reason: access.reason,
      provenance: provenanceFor(ctx.state),
    });
  }

  const profile = await getStyleProfile(ctx.userId, "gmail", "generic");
  const state: State = {
    ...ctx.state,
    style: profile ? { kind: "profile", styleProfileId: profile.id } : { kind: "style_missing" },
    recipients: { to: ctx.state.sender ? [ctx.state.sender] : [], cc: [] },
  };
  await ctx.log(
    `gather: access=ok style=${state.style?.kind ?? "?"} to=${state.recipients?.to.join(",") ?? ""}`,
  );
  return { kind: "next", state, nextStep: "compose" };
}

async function runCompose(ctx: StepContext<State>): Promise<StepResult<State>> {
  // #237 replaces this body: compose with the style profile, then
  // `prepareReplyStaging` → `ctx.stageAction(gmail.send_draft)` → `staged`.
  await ctx.log("compose: no composer registered (#237); recording no_draft");
  return finish(
    ctx,
    ctx.state,
    noDraftResult("composer_unavailable", null, provenanceFor(ctx.state)),
  );
}

export const replyDraftingWorkflow: Workflow<State> = {
  slug: REPLY_DRAFTING_WORKFLOW_SLUG,
  name: "Reply drafting",
  description:
    "Decide whether an inbound email deserves a drafted reply and, when it does, stage one for approval (ADR-0098).",
  trigger: { kind: "event", source: "email-triage", type: "reply_worthy" },
  initialStep: "gate",
  stateSchema,
  closure: { kind: "none" },
  initialState(input) {
    const parsed = replyDraftingWorkflowInputSchema.parse(input.input ?? {});
    return {
      documentId: parsed.documentId,
      sourceThreadId: parsed.sourceThreadId,
      invocation: parsed.invocation,
      triage: parsed.triage ?? null,
    };
  },
  steps: {
    gate: { id: "gate", run: runGate },
    gather: { id: "gather", run: runGather },
    compose: { id: "compose", run: runCompose },
  },
};
