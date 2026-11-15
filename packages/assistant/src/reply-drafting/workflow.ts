import {
  replyDraftMessageSchema,
  replyDraftProvenanceSchema,
  replyDraftResultSchema,
  replyDraftInvocationSchema,
  replyDraftStandingInstructionSchema,
  replyDraftStyleSelectionSchema,
  replyDraftTriageSnapshotSchema,
  toMessage,
  type ReplyDraftMessage,
  type ReplyDraftProvenance,
  type ReplyDraftResult,
  type ReplyDraftTriageSnapshot,
  REPLY_DRAFTING_WORKFLOW_SLUG,
} from "@alfred/contracts";
import { z } from "zod";
import type { StepContext, StepResult, Workflow } from "@alfred/assistant/execution";
import { standingInstructions } from "@alfred/assistant/knowledge";
import { withdrawToolCallApproval } from "@alfred/assistant/tool-runtime";
import { settings } from "@alfred/assistant/settings";
import { integrations } from "@alfred/integrations";
import {
  extractSenderContext,
  getThreadState,
  getTriage,
  recipientAddresses,
  type TriageRow,
} from "@alfred/assistant/triage";
import { checkGmailDraftAccess } from "./access";
import { composeReply } from "./compose";
import { gatherReplyContext, loadReplyDocument, replyGatherSchema } from "./gather";
import { prepareReplyStaging } from "./verifier";
// Side-effect import: registers the `reply_drafting.decision` trace kind.
import "./decision";
import { replyDraftingWorkflowInputSchema } from "./workflow-input";
import { decideReplyWorthiness, noDraftResult, replyStandingInstructionState } from "./worthiness";

/**
 * `reply-drafting` workflow (ADR-0098, amended 2026-11-15): `gate`, `gather`, `compose`,
 * `stage`. `gate` reruns the rubric on the live row. `gather` checks the mailbox can write
 * a Gmail draft and freezes the facts the verifier binds to. `compose` freezes one verified
 * candidate before `stage`. `stage` creates the Gmail draft on the source thread through the
 * integration client; the user reviews and sends it in Gmail. No approval card. Resuming
 * never composes a second body. `no_draft`, `no_access`, and `withheld` are completed runs
 * with a typed reason, not failures.
 */

/** The draft one `stage` attempt created. The same key the send tool kept. */
const replyDraftRefSchema = z.object({
  credentialId: z.string().min(1),
  draftId: z.string().min(1),
  threadId: z.string().min(1),
  /** Epoch ms on Alfred's clock, just before the draft was saved. Not Gmail's clock. */
  alfredSavedAt: z.number(),
});

type ReplyDraftRef = z.infer<typeof replyDraftRefSchema>;

const stateSchema = z.object({
  documentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  invocation: replyDraftInvocationSchema,
  triage: replyDraftTriageSnapshotSchema.nullable(),
  featureFlagEnabled: z.boolean().optional(),
  standingInstruction: replyDraftStandingInstructionSchema.optional(),
  sender: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  mailbox: z.object({ accountId: z.string().min(1), address: z.string().nullable() }).optional(),
  threadParticipants: z.array(z.string()).optional(),
  recipients: z.object({ to: z.array(z.string()), cc: z.array(z.string()) }).optional(),
  style: replyDraftStyleSelectionSchema.optional(),
  gather: replyGatherSchema.optional(),
  prepared: z
    .object({ input: replyDraftMessageSchema, provenance: replyDraftProvenanceSchema })
    .optional(),
  /** The created draft, recorded before the result, so a retry reuses it. */
  draft: replyDraftRefSchema.optional(),
  result: replyDraftResultSchema.optional(),
});

type State = z.infer<typeof stateSchema>;

const REPLY_TOOL_CALL_ID = "reply-draft";

/** `email_triage.document_id` can outlive its document, so null falls back to the run's document. */
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
    standingInstruction: state.standingInstruction ?? null,
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
  const flags = await settings({ userId: ctx.userId }).flags();
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

  const suppressions = await standingInstructions({ userId: ctx.userId, onReadFailure: "report" });

  const instructions = suppressions.forMail({
    sender: senderContextResult.senderAddress,
    accountId: document.accountId,
  });

  // The row is for this document (checked above), so its evaluation is current for it. The
  // gate and the record use the effective result, never the cached row (ADR-0113 rule 3).
  const { standing: standingInstruction, triage } = replyStandingInstructionState({
    instructions,
    triage: row,
    documentId: ctx.state.documentId,
    snapshot: row ? snapshotFromRow(row, ctx.state.documentId) : null,
  });

  if (instructions.kind === "read_failed") {
    await ctx.log(`gate: standing instruction read failed: ${toMessage(instructions.error)}`);
  }

  const state: State = {
    ...ctx.state,
    triage,
    featureFlagEnabled: flags.replyDrafting,
    standingInstruction,
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
    // The reply state comes from the thread timestamps above.
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

  const access = await checkGmailDraftAccess({ userId: ctx.userId, accountId: mailbox.accountId });

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

  // Commit the candidate before dispatch, so retries and resumes use one body and one call id.
  return {
    kind: "next",
    nextStep: "stage",
    state: { ...ctx.state, prepared: { input: plan.input, provenance } },
  };
}

async function runStage(ctx: StepContext<State>): Promise<StepResult<State>> {
  const result = await draftReply(ctx);

  if (result.kind === "done") {
    // A legacy staged run parks on an approval row that names the deleted send tool; close
    // it on early exit. New runs stage nothing.
    await withdrawToolCallApproval({
      userId: ctx.userId,
      runId: ctx.runId,
      stepId: "stage",
      attempt: ctx.attempt,
      toolCallId: REPLY_TOOL_CALL_ID,
      reason: "Reply drafting no longer stages an approval.",
    });
  }

  return result;
}

/**
 * Save one plain-text Gmail draft on the source thread through the integration client, the
 * same call the send tool made. The step writes nothing to `action_stagings`.
 */
async function createReplyDraft(args: {
  userId: string;
  accountRef: string;
  credentialId: string;
  input: ReplyDraftMessage;
}): Promise<ReplyDraftRef> {
  const alfredSavedAt = Date.now();

  const draft = await integrations({
    userId: args.userId,
    accountRef: args.accountRef,
    retry: "none",
  }).google.gmail.createDraft({
    credentialId: args.credentialId,
    to: args.input.to,
    ...(args.input.cc?.length ? { cc: args.input.cc } : {}),
    subject: args.input.subject,
    bodyText: args.input.bodyText,
    // The verifier checked it; the draft groups into the inbound thread.
    threadId: args.input.threadId,
  });

  return {
    credentialId: args.credentialId,
    draftId: draft.draftId,
    threadId: draft.threadId,
    alfredSavedAt,
  };
}

/**
 * The stage step creates the Gmail draft itself (owner decision of 2026-11-15: Alfred makes
 * drafts only and never sends mail). On a verifier pass it writes the draft on the source
 * thread and finishes with the `staged` outcome; no approval card, no staging row.
 */
async function draftReply(ctx: StepContext<State>): Promise<StepResult<State>> {
  const { prepared, mailbox, gather } = ctx.state;

  if (!prepared || !mailbox || !gather)
    throw new Error("[reply-drafting] stage entered without verified input");

  if (ctx.state.result) {
    // A resumed run keeps its recorded decision. A legacy staged run carries the staging
    // result it parked on; `runStage` closes its approval row.
    return finish(ctx, ctx.state, ctx.state.result);
  }

  // Compose can be slow: recheck gate and access before the first write.
  const gate = await runGate(ctx);

  if (gate.kind !== "next") return gate;
  const access = await checkGmailDraftAccess({ userId: ctx.userId, accountId: mailbox.accountId });

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
      detail: "The mailbox or sender changed before the draft.",
      provenance: prepared.provenance,
    });
  }

  // One draft per source message: a committed retry reuses the recorded ref. A crash between
  // Gmail's answer and this step's commit can save a second draft (residual risk).
  const draft =
    ctx.state.draft ??
    (await createReplyDraft({
      userId: ctx.userId,
      accountRef: mailbox.accountId,
      credentialId: access.credentialId,
      input: prepared.input,
    }));

  const result: ReplyDraftResult = {
    outcome: "staged",
    stagingId: null,
    draftId: draft.draftId,
    provenance: prepared.provenance,
  };

  return finish(ctx, { ...ctx.state, draft }, result);
}

export const replyDraftingWorkflow: Workflow<
  State,
  string,
  unknown,
  z.output<typeof replyDraftingWorkflowInputSchema>
> = {
  slug: REPLY_DRAFTING_WORKFLOW_SLUG,
  name: "Reply drafting",
  description:
    "Decide whether an inbound email deserves a drafted reply and, when it does, create a Gmail draft for the user to review and send (ADR-0098).",
  trigger: { kind: "event", source: "email-triage", type: "reply_worthy" },
  initialStep: "gate",
  stateSchema,
  inputSchema: replyDraftingWorkflowInputSchema,
  closure: { kind: "none" },
  initialState({ input: parsed }) {
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
