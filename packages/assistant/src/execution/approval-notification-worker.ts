/** Approval notification worker (ADR-0034). Scheduling lives in `tool-runtime`. */

import {
  humanizeSlug,
  humanizeToolName,
  isQuestionApproval,
  isRecord,
  jsonValueSchema,
  type JsonValue,
  type ToolName,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings, agentRuns } from "@alfred/db/schemas";
import { renderApprovalEmail, type ApprovalEmailField } from "@alfred/mailer";
import { and, eq, sql } from "drizzle-orm";
import { Worker, type Job } from "bullmq";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { createRedisConnection } from "@alfred/db/redis";
import { send } from "@alfred/assistant/delivery";
import {
  APPROVAL_NOTIFICATION_QUEUE_NAME,
  approvalNotificationJobDataSchema,
  workflowBlockedNotificationJobDataSchema,
  type NotificationJobData,
} from "@alfred/assistant/tool-runtime";
import { emailLogoUrl, webOrigin } from "@alfred/assistant/settings";
import {
  processWorkflowBlockedNotification,
  type WorkflowBlockedNotificationResult,
} from "./workflow-blocked-notification";

let _worker: Worker<NotificationJobData> | undefined;

export interface StartApprovalNotificationWorkerOpts {
  concurrency?: number;
}

export async function startApprovalNotificationWorker(
  opts: StartApprovalNotificationWorkerOpts = {},
): Promise<void> {
  if (_worker) return;
  _worker = new Worker<NotificationJobData>(
    APPROVAL_NOTIFICATION_QUEUE_NAME,
    processNotificationJob,
    {
      connection: createRedisConnection("queue"),
      concurrency: opts.concurrency ?? 1,
    },
  );
  _worker.on("error", (err) => {
    console.error("[approvals:worker] error:", err.message);
  });
}

export async function stopApprovalNotificationWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = undefined;
}

/** A failed send throws so BullMQ retries; it is never returned. */
export type ApprovalNotificationResult =
  | { status: "missing"; stagingId: string }
  | { status: "skipped"; reason: string; stagingId: string }
  | { status: "sent" | "duplicate"; stagingId: string; emailSendId: string };

/** Two job shapes (#561): an approval job with no `kind`, and `kind: "workflow_blocked"`. */
async function processNotificationJob(
  job: Job<NotificationJobData>,
): Promise<ApprovalNotificationResult | WorkflowBlockedNotificationResult> {
  const blocked = workflowBlockedNotificationJobDataSchema.safeParse(job.data);

  if (blocked.success) return processWorkflowBlockedNotification(blocked.data);

  return processApprovalNotificationJob(approvalNotificationJobDataSchema.parse(job.data));
}

async function processApprovalNotificationJob({
  stagingId,
  userId,
}: {
  stagingId: string;
  userId: string;
}): Promise<ApprovalNotificationResult> {
  const rows = await db()
    .select({
      id: actionStagings.id,
      userId: actionStagings.userId,
      runId: actionStagings.runId,
      stepId: actionStagings.stepId,
      toolName: actionStagings.toolName,
      integration: actionStagings.integration,
      riskTier: actionStagings.riskTier,
      proposedInput: actionStagings.proposedInput,
      displayInput: actionStagings.displayInput,
      status: actionStagings.status,
      notifiedAt: actionStagings.notifiedAt,
      workflowSlug: agentRuns.workflowSlug,
    })
    .from(actionStagings)
    .innerJoin(agentRuns, eq(actionStagings.runId, agentRuns.id))
    .where(and(eq(actionStagings.id, stagingId), eq(actionStagings.userId, userId)))
    .limit(1);

  const row = rows[0];

  if (!row) return { status: "missing", stagingId };

  if (row.status !== "pending") return { status: "skipped", reason: row.status, stagingId };

  if (row.notifiedAt) return { status: "skipped", reason: "already_notified", stagingId };

  // Use the redacted `display_input`, never the raw payload (#374). The fallback is for legacy
  // rows.
  const displayInput = jsonValueSchema.parse(row.displayInput ?? row.proposedInput);
  const approvalUrl = approvalDeepLink(stagingId);

  const rendered = await renderApprovalNotification({
    stagingId,
    runId: row.runId,
    stepId: row.stepId,
    workflowSlug: row.workflowSlug,
    toolName: row.toolName,
    integration: row.integration,
    riskTier: row.riskTier,
    displayInput,
    approvalUrl,
  });

  const result = await send({
    userId: row.userId,
    kind: "approval",
    idempotencyKey: `approval:${stagingId}`,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    payload: {
      stagingId,
      runId: row.runId,
      stepId: row.stepId,
      workflowSlug: row.workflowSlug,
      toolName: row.toolName,
      integration: row.integration,
      riskTier: row.riskTier,
      approvalUrl,
      displayInput,
    },
  });

  // Throw so BullMQ retries. A stamped `notified_at` would block every later attempt.
  if (result.status === "failed") {
    throw new Error(
      `[approval-notification] send failed for staging ${stagingId}: ${result.error}`,
    );
  }

  const now = new Date();

  const updated = await db()
    .update(actionStagings)
    .set({
      notifiedAt: now,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
    })
    .where(
      and(
        eq(actionStagings.id, stagingId),
        eq(actionStagings.userId, row.userId),
        eq(actionStagings.status, "pending"),
      ),
    )
    .returning({ id: actionStagings.id });

  if (updated[0]) emitReplicachePokes([row.userId], stagingId);

  return { status: result.status, stagingId, emailSendId: result.emailSendId };
}

interface RenderApprovalNotificationArgs {
  stagingId: string;
  runId: string;
  stepId: string;
  workflowSlug: string;
  toolName: ToolName;
  integration: string;
  riskTier: string;
  displayInput: JsonValue;
  approvalUrl: string;
}

async function renderApprovalNotification(args: RenderApprovalNotificationArgs): Promise<{
  subject: string;
  html: string;
  text: string;
}> {
  // A question asks for an answer, not a decision, so it gets no risk prefix (ADR-0099).
  const isQuestion = isQuestionApproval(args.toolName);
  const action = humanizeToolName(args.toolName);
  const heading = isQuestion ? "Alfred has a question for you" : `Alfred wants to ${action}`;
  const subject = isQuestion ? heading : `[${args.riskTier}] ${heading}`;
  const inputFields = summarizeInput(args.displayInput);

  const fields: ApprovalEmailField[] = [
    { label: "Workflow", value: args.workflowSlug },
    { label: "Tool", value: args.toolName },
    { label: "Risk", value: args.riskTier },
    ...inputFields,
  ];

  const textLines = [
    subject,
    "",
    ...fields.map((f) => `${f.label}: ${f.value}`),
    `Run: ${args.runId}`,
    `Step: ${args.stepId}`,
    "",
    `Review: ${args.approvalUrl}`,
  ];

  const html = await renderApprovalEmail({
    heading,
    riskTier: args.riskTier,
    fields,
    approvalUrl: args.approvalUrl,
    runId: args.runId,
    stagingId: args.stagingId,
    logoUrl: emailLogoUrl(),
  });

  return { subject, html, text: textLines.join("\n") };
}

function approvalDeepLink(stagingId: string): string {
  return `${webOrigin()}/approvals#approval-${encodeURIComponent(stagingId)}`;
}

function summarizeInput(input: JsonValue): Array<{ label: string; value: string }> {
  if (!isRecord(input)) {
    return [{ label: "Input", value: truncate(formatValue(input), 500) }];
  }

  const entries = Object.entries(input).slice(0, 8);

  if (entries.length === 0) return [{ label: "Input", value: "{}" }];

  return entries.map(([key, value]) => ({
    label: humanizeSlug(key),
    value: truncate(formatValue(value), 500),
  }));
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;

  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (value == null) return "None";

  return JSON.stringify(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
