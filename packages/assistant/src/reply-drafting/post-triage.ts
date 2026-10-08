import { toMessage, type ReplyDraftProvenance } from "@alfred/contracts";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { startRun } from "@alfred/assistant/execution";
import { findActiveSenderSuppression } from "@alfred/assistant/knowledge";
import { resolveFeatureFlags } from "@alfred/assistant/settings";
import {
  emailTriageClassifiedPayloadSchema,
  type DomainEvent,
  type EmailTriageClassifiedPayload,
  type TriggerConsumer,
} from "@alfred/assistant/triggers";
import { recordReplyDraftDecision } from "./decision";
import { REPLY_DRAFTING_WORKFLOW_SLUG, type ReplyDraftingWorkflowInput } from "./workflow-input";
import {
  decideReplyWorthiness,
  noDraftResult,
  type ReplyStandingInstructionState,
} from "./worthiness";

/**
 * Post-triage consumer (ADR-0098) of `email-triage.classified`. Triage imports nothing from here.
 * Reads the flag and the `block_reply_draft` instruction, runs the gate, then records
 * `no_draft` or starts one `reply-drafting` run. Best-effort: it must never fail triage.
 * With the flag off (the default) it returns before any read.
 */

const CONSUMER_NAME = "reply-drafting-post-triage";

function isoToDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function provenanceFor(
  payload: EmailTriageClassifiedPayload,
  featureFlagEnabled: boolean,
): ReplyDraftProvenance {
  return {
    invocation: "post_triage",
    featureFlagEnabled,
    triage: payload.triage,
    inbound: {
      documentId: payload.triage.documentId,
      sourceThreadId: payload.triage.sourceThreadId,
      messageId: null,
    },
    sender: payload.sender.address,
    recipients: { to: [], cc: [] },
    style: null,
    gatheredObjects: [],
    verifier: null,
  };
}

async function readStandingInstruction(
  userId: string,
  payload: EmailTriageClassifiedPayload,
): Promise<ReplyStandingInstructionState> {
  try {
    const match = await findActiveSenderSuppression(userId, {
      senderEmail: payload.sender.address,
      accountId: payload.mailbox.accountId,
      effect: "block_reply_draft",
    });

    return match ? "suppress" : "none";
  } catch (err) {
    console.warn(`[${CONSUMER_NAME}] standing instruction read failed: ${toMessage(err)}`);

    return "read_failed";
  }
}

export async function acceptEmailTriageClassified(event: DomainEvent): Promise<void> {
  if (event.source !== "email-triage" || event.type !== "classified") return;
  const payload = emailTriageClassifiedPayloadSchema.parse(event.payload);

  const flags = await resolveFeatureFlags(event.userId);

  if (!flags.replyDrafting) return;

  const standingInstruction = await readStandingInstruction(event.userId, payload);

  const decision = decideReplyWorthiness({
    invocation: "post_triage",
    featureFlagEnabled: true,
    triage: payload.triage,
    sender: { effectiveAuthor: payload.sender.effectiveAuthor },
    thread: {
      inboundAuthoredAt: isoToDate(payload.thread.inboundAuthoredAt),
      lastUserReplyAt: isoToDate(payload.thread.lastUserReplyAt),
    },
    triageReason: payload.triageReason,
    standingInstruction,
  });

  if (!decision.worthy) {
    await recordReplyDraftDecision({
      userId: event.userId,
      runId: payload.triageStep.runId,
      stepId: payload.triageStep.stepId,
      attempt: payload.triageStep.attempt,
      result: noDraftResult(decision.reason, decision.note, provenanceFor(payload, true)),
    });

    return;
  }

  // One run per (thread, message): the occurrence id turns a re-classify into a unique violation.
  const eventId = `${payload.triage.sourceThreadId}:${payload.triage.documentId}`;

  const input: ReplyDraftingWorkflowInput = {
    documentId: payload.triage.documentId,
    sourceThreadId: payload.triage.sourceThreadId,
    invocation: "post_triage",
    triage: payload.triage,
  };

  try {
    await startRun({
      userId: event.userId,
      workflowSlug: REPLY_DRAFTING_WORKFLOW_SLUG,
      input,
      metadata: { triageRunId: payload.triageStep.runId },
      trigger: { kind: "event", source: "email-triage", type: "reply_worthy", eventId },
      workflowRevisionId: null,
      occurrence: {
        kind: "event",
        workflowId: REPLY_DRAFTING_WORKFLOW_SLUG,
        provider: "email-triage",
        eventId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.warn(`[${CONSUMER_NAME}] reply-drafting run already exists for ${eventId}`);

      return;
    }

    throw err;
  }
}

export function replyDraftingTriggerConsumer(): TriggerConsumer {
  return { name: CONSUMER_NAME, mode: "best-effort", accept: acceptEmailTriageClassified };
}
