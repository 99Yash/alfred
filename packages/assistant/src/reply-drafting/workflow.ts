import {
  gmailSendDraftInput,
  replyDraftProvenanceSchema,
  replyDraftResultSchema,
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
import { executeToolCallRound, withdrawToolCallApproval } from "@alfred/assistant/tool-runtime";
import { resolveFeatureFlags } from "@alfred/assistant/settings";
import {
  extractSenderContext,
  getThreadState,
  getTriage,
  recipientAddresses,
  type TriageRow,
} from "@alfred/assistant/triage";
import { checkGmailSendAccess } from "./access";
import { composeReply } from "./compose";
import { gatherReplyContext, loadReplyDocument, replyGatherSchema } from "./gather";
import { prepareReplyStaging } from "./verifier";
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
 * The `reply-drafting` workflow (ADR-0098): `gate` → `gather` → `compose` → `stage`.
 *
 * `gate` re-runs the worthiness rubric on the live row so a run started by a
 * stale event (or by hand) decides from what is true now. `gather` proves the
 * mailbox can send, picks the style profile, and freezes the recipient and
 * participant facts the verifier will bind to. `compose` freezes a verified
 * candidate before `stage` enters the tool dispatcher. The run waits for the
 * existing approval flow; resuming never composes a second body.
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
  gather: replyGatherSchema.optional(),
  prepared: z
    .object({ input: gmailSendDraftInput, provenance: replyDraftProvenanceSchema })
    .optional(),
  result: replyDraftResultSchema.optional(),
});

type State = z.infer<typeof stateSchema>;

const REPLY_TOOL_CALL_ID = "reply-draft";

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
    gatheredObjects: state.gather?.sources ?? [],
    verifier: null,
  };
}

function finish(
  ctx: StepContext<State>,
  state: State,
  result: ReplyDraftResult,
): StepResult<State> {
  const output = replyDraftResultSchema.parse(result);
  ctx.trace("reply_drafting.decision", output);

  return { kind: "done", state, output };
}

async function runGate(ctx: StepContext<State>): Promise<StepResult<State>> {
  const flags = await resolveFeatureFlags(ctx.userId);
  const flagged = { ...ctx.state, featureFlagEnabled: flags.replyDrafting };

  if (flagged.invocation === "post_triage" && !flags.replyDrafting) {
    return finish(ctx, flagged, noDraftResult("feature_disabled", null, provenanceFor(flagged)));
  }

  const document = await loadReplyDocument(ctx.userId, ctx.state.documentId);

  if (!document) {
    return finish(ctx, flagged, noDraftResult("source_unavailable", null, provenanceFor(flagged)));
  }

  if (!document.sourceThreadId || document.sourceThreadId !== ctx.state.sourceThreadId) {
    return finish(ctx, flagged, {
      outcome: "withheld",
      reason: document.sourceThreadId ? "context_mismatch" : "missing_thread_id",
      detail: "The source document does not identify the requested thread.",
      provenance: provenanceFor(flagged),
    });
  }

  if (!document.accountId) {
    return finish(ctx, flagged, {
      outcome: "no_access",
      reason: "gmail_not_connected",
      provenance: provenanceFor(flagged),
    });
  }

  const senderContextResult = extractSenderContext({
    fromHeader: document.metadata.from ?? null,
    subject: document.title,
    body: document.content,
  });

  const row = await getTriage(ctx.userId, ctx.state.sourceThreadId);
  const triage = row ? snapshotFromRow(row, ctx.state.documentId) : null;

  if (row && row.documentId !== ctx.state.documentId) {
    return finish(
      ctx,
      flagged,
      noDraftResult(
        "source_unavailable",
        "A newer document owns this thread's triage.",
        provenanceFor(flagged),
      ),
    );
  }

  const threadState = await getThreadState({
    userId: ctx.userId,
    sourceThreadId: ctx.state.sourceThreadId,
    excludeDocumentId: ctx.state.documentId,
    accountId: document.accountId,
  });

  let standingInstruction: ReplyStandingInstructionState = "none";

  try {
    const match = await findActiveSenderSuppression(ctx.userId, {
      senderEmail: senderContextResult.senderAddress,
      accountId: document.accountId,
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
    messageId: document.sourceId,
    mailbox: { accountId: document.accountId, address: null },
    threadParticipants: [
      ...recipientAddresses(document.metadata.from),
      ...recipientAddresses(document.metadata.to),
      ...recipientAddresses(document.metadata.cc),
    ],
  };

  const shared = {
    featureFlagEnabled: flags.replyDrafting,
    sender: { effectiveAuthor: senderContextResult.context.effectiveAuthor },
    thread: {
      inboundAuthoredAt: document.authoredAt,
      lastUserReplyAt: threadState.lastUserReplyAt,
    },
    // The run has no gmail.message_received reason of its own; the reply state
    // comes from the thread timestamps read above.
    triageReason: null,
    standingInstruction,
  };

  if (state.invocation === "post_triage" && !triage) {
    return finish(ctx, state, noDraftResult("triage_unavailable", null, provenanceFor(state)));
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

  const document = await loadReplyDocument(ctx.userId, ctx.state.documentId);

  if (!document) {
    return finish(
      ctx,
      ctx.state,
      noDraftResult("source_unavailable", null, provenanceFor(ctx.state)),
    );
  }

  if (
    document.sourceThreadId !== ctx.state.sourceThreadId ||
    document.accountId !== mailbox.accountId
  ) {
    return finish(ctx, ctx.state, {
      outcome: "withheld",
      reason: "context_mismatch",
      detail: null,
      provenance: provenanceFor(ctx.state),
    });
  }

  if (
    extractSenderContext({
      fromHeader: document.metadata.from ?? null,
      subject: document.title,
      body: document.content,
    }).senderAddress !== ctx.state.sender
  ) {
    return finish(ctx, ctx.state, {
      outcome: "withheld",
      reason: "context_mismatch",
      detail: "The sender changed after gating.",
      provenance: provenanceFor(ctx.state),
    });
  }

  const gather = await gatherReplyContext({
    userId: ctx.userId,
    document,
    sender: ctx.state.sender ?? null,
    mailboxAddress: access.mailboxAddress,
    relationship:
      ctx.state.triage?.senderRelationshipIsCold === false ? "established_contact" : "unknown",
  });

  const state: State = {
    ...ctx.state,
    mailbox: { ...mailbox, address: access.mailboxAddress },
    gather,
    style: gather.style,
    recipients: gather.replyRecipients,
  };

  return { kind: "next", state, nextStep: "compose" };
}

async function runCompose(ctx: StepContext<State>): Promise<StepResult<State>> {
  const { gather, mailbox, recipients } = ctx.state;

  if (!gather || !mailbox || !recipients) throw new Error("[reply-drafting] missing gather state");

  const composed = await composeReply({
    gather,
    userId: ctx.userId,
    runId: ctx.runId,
    idempotencyKey: ctx.idempotencyKey,
  });

  const plan = prepareReplyStaging(
    {
      ...composed,
      sourceThreadId: ctx.state.sourceThreadId,
      recipients,
      subject: gather.subject,
    },
    {
      mailboxAddress: mailbox.address,
      threadParticipants: ctx.state.threadParticipants ?? [],
      style: gather.style,
      featureFlagEnabled: ctx.state.featureFlagEnabled ?? false,
    },
  );

  const provenance = { ...provenanceFor(ctx.state), verifier: plan.verifier };

  if (plan.kind === "withheld") {
    return finish(ctx, ctx.state, {
      outcome: "withheld",
      reason: plan.reason,
      detail: plan.detail,
      provenance,
    });
  }

  // Commit the exact candidate before dispatch so retries and approval resumes
  // use one body, one tool-call identity, and the original inbound mailbox.
  return {
    kind: "next",
    nextStep: "stage",
    state: { ...ctx.state, prepared: { input: plan.input, provenance } },
  };
}

async function runStage(ctx: StepContext<State>): Promise<StepResult<State>> {
  const result = await dispatchReply(ctx);

  if (result.kind === "done") {
    // The action insert and workflow checkpoint are separate commits. Close
    // any pending row even when this attempt exits before reaching dispatch.
    await withdrawToolCallApproval({
      userId: ctx.userId,
      runId: ctx.runId,
      stepId: "stage",
      attempt: ctx.attempt,
      toolCallId: REPLY_TOOL_CALL_ID,
      reason: "Reply drafting completed without a pending approval.",
    });
  }

  return result;
}

async function dispatchReply(ctx: StepContext<State>): Promise<StepResult<State>> {
  const { prepared, mailbox } = ctx.state;

  if (!prepared || !mailbox)
    throw new Error("[reply-drafting] stage entered without verified input");

  if (!ctx.state.result) {
    // Compose can take time. Recheck the live gate and access before creating
    // the first approval; approved resumes remain owned by the dispatcher.
    const gate = await runGate(ctx);

    if (gate.kind !== "next") return gate;
    const access = await checkGmailSendAccess({ userId: ctx.userId, accountId: mailbox.accountId });

    if (!access.ok)
      return finish(ctx, ctx.state, {
        outcome: "no_access",
        reason: access.reason,
        provenance: prepared.provenance,
      });

    if (
      gate.state.mailbox?.accountId !== mailbox.accountId ||
      gate.state.sender !== ctx.state.sender ||
      access.mailboxAddress !== mailbox.address
    ) {
      return finish(ctx, ctx.state, {
        outcome: "withheld",
        reason: "context_mismatch",
        detail: "The mailbox or sender changed before staging.",
        provenance: prepared.provenance,
      });
    }
  }

  const round = await executeToolCallRound({
    calls: [
      { toolCallId: REPLY_TOOL_CALL_ID, toolName: "gmail.send_draft", input: prepared.input },
    ],
    transcript: ctx.transcript,
    activeNames: ["gmail.send_draft"],
    run: {
      runId: ctx.runId,
      stepId: "stage",
      userId: ctx.userId,
      workflow: REPLY_DRAFTING_WORKFLOW_SLUG,
      fence: ctx.fence,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      allowedTools: ["gmail.send_draft"],
      requiredCapabilities: [{ tool: "gmail.send_draft", accountRef: mailbox.accountId }],
    },
  });

  if (round.kind === "waiting") {
    if (round.wake.kind !== "hil" || round.wake.approvalKind !== "action_staging") {
      throw new Error("[reply-drafting] expected an action-staging approval");
    }

    const result: ReplyDraftResult = {
      outcome: "staged",
      actionKind: "approval_staged_send",
      stagingId: round.wake.approvalId,
      provenance: prepared.provenance,
    };

    ctx.trace("reply_drafting.decision", result);

    return { kind: "interrupt", state: { ...ctx.state, result }, wake: round.wake };
  }

  // A resumed run uses the dispatcher's stored approved/edited input. Its
  // transcript and action row record send/rejection/failure independently of
  // the drafting decision, which remains the historical staging result.
  const result =
    ctx.state.result ??
    ({
      outcome: "withheld",
      reason: "staging_unavailable",
      detail: "The dispatcher did not offer an approval.",
      provenance: prepared.provenance,
    } satisfies ReplyDraftResult);

  return { ...finish(ctx, ctx.state, result), transcript: round.transcript };
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
    stage: { id: "stage", run: runStage },
  },
};
