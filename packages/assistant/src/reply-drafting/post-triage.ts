import { type ReplyDraftProvenance, REPLY_DRAFTING_WORKFLOW_SLUG } from "@alfred/contracts";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { startRun } from "@alfred/assistant/execution";
import { standingInstructions } from "@alfred/assistant/knowledge";
import { settings } from "@alfred/assistant/settings";
import { getTriage } from "@alfred/assistant/triage";
import {
  type DomainEvent,
  type EmailTriageClassifiedPayload,
  type TriggerConsumer,
} from "@alfred/assistant/triggers";
import { recordReplyDraftDecision } from "./decision";
import type { ReplyDraftingWorkflowInput } from "./workflow-input";
import {
  decideReplyWorthiness,
  noDraftResult,
  replyStandingInstructionState,
  type ReplyStandingRead,
} from "./worthiness";
import { logger } from "@alfred/logging";

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
  standing: ReplyStandingRead,
): ReplyDraftProvenance {
  return {
    invocation: "post_triage",
    featureFlagEnabled,
    triage: standing.triage ?? payload.triage,
    standingInstruction: standing.standing,
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

/**
 * The `block_reply_draft` state and the effective snapshot (ADR-0113). The row holds the
 * evaluation that triage just stored, so a scoped block decides here as it does in the
 * workflow gate. A row that a newer document owns is not this document's result.
 */
async function readStandingInstruction(
  userId: string,
  payload: EmailTriageClassifiedPayload,
): Promise<ReplyStandingRead> {
  const [suppressions, triage] = await Promise.all([
    standingInstructions({ userId, onReadFailure: "report" }),
    getTriage(userId, payload.triage.sourceThreadId).then(
      (row) => ({ kind: "read" as const, row }),
      (error: unknown) => ({ kind: "read_failed" as const, error }),
    ),
  ]);

  const instructions = suppressions.forMail({
    sender: payload.sender.address,
    accountId: payload.mailbox.accountId,
  });

  const failure =
    instructions.kind === "read_failed"
      ? instructions.error
      : triage.kind === "read_failed"
        ? triage.error
        : null;

  if (failure !== null) {
    logger.warn({ err: failure }, `[${CONSUMER_NAME}] standing instruction read failed`);

    return { standing: { state: "read_failed" }, triage: payload.triage };
  }

  const row = triage.kind === "read" ? triage.row : null;

  return replyStandingInstructionState({
    instructions,
    triage: row?.documentId === payload.triage.documentId ? row : null,
    documentId: payload.triage.documentId,
    snapshot: payload.triage,
  });
}

export async function acceptEmailTriageClassified(event: DomainEvent): Promise<void> {
  if (event.source !== "email-triage" || event.type !== "classified") return;
  const { payload } = event;

  const flags = await settings({ userId: event.userId }).flags();

  if (!flags.replyDrafting) return;

  const standing = await readStandingInstruction(event.userId, payload);
  const triage = standing.triage ?? payload.triage;

  const decision = decideReplyWorthiness({
    invocation: "post_triage",
    featureFlagEnabled: true,
    triage,
    sender: { effectiveAuthor: payload.sender.effectiveAuthor },
    thread: {
      inboundAuthoredAt: isoToDate(payload.thread.inboundAuthoredAt),
      lastUserReplyAt: isoToDate(payload.thread.lastUserReplyAt),
    },
    triageReason: payload.triageReason,
    standingInstruction: standing.standing,
  });

  if (!decision.worthy) {
    await recordReplyDraftDecision({
      userId: event.userId,
      runId: payload.triageStep.runId,
      stepId: payload.triageStep.stepId,
      attempt: payload.triageStep.attempt,
      result: noDraftResult(
        decision.reason,
        decision.note,
        provenanceFor(payload, true, standing),
      ),
    });

    return;
  }

  // One run per (thread, message): the occurrence id turns a re-classify into a unique violation.
  const eventId = `${payload.triage.sourceThreadId}:${payload.triage.documentId}`;

  const input: ReplyDraftingWorkflowInput = {
    documentId: payload.triage.documentId,
    sourceThreadId: payload.triage.sourceThreadId,
    invocation: "post_triage",
    triage,
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
      logger.warn(`[${CONSUMER_NAME}] reply-drafting run already exists for ${eventId}`);

      return;
    }

    throw err;
  }
}

export function replyDraftingTriggerConsumer(): TriggerConsumer {
  return { name: CONSUMER_NAME, mode: "best-effort", accept: acceptEmailTriageClassified };
}
