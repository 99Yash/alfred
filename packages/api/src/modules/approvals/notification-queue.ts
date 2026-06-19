import { humanizeSlug, humanizeToolName, isRecord } from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings, agentRuns } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { renderApprovalEmail, type ApprovalEmailField } from "@alfred/mailer";
import { and, eq, sql } from "drizzle-orm";
import { Queue, Worker, type Job } from "bullmq";
import { z } from "zod";
import { emitReplicachePokes } from "../../events/replicache-events";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";
import { notify } from "../notifications";

export const APPROVAL_NOTIFICATION_QUEUE_NAME = "staging-notify";

export const approvalNotificationJobDataSchema = z.object({
  stagingId: z.string().min(1),
  userId: z.string().min(1),
});
export type ApprovalNotificationJobData = z.infer<typeof approvalNotificationJobDataSchema>;

let _queue: Queue<ApprovalNotificationJobData> | undefined;
let _worker: Worker<ApprovalNotificationJobData> | undefined;

export function approvalNotificationJobId(stagingId: string): string {
  // BullMQ custom job ids cannot contain `:`, so this mirrors the
  // plan's `staging-notify:<id>` logical id with a dot separator.
  return `staging-notify.${stagingId}`;
}

export function getApprovalNotificationQueue(): Queue<ApprovalNotificationJobData> {
  if (_queue) return _queue;
  _queue = new Queue<ApprovalNotificationJobData>(APPROVAL_NOTIFICATION_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 100, age: 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });
  return _queue;
}

export async function scheduleApprovalNotificationJob(args: {
  stagingId: string;
  userId: string;
  delayMs: number;
}): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled()) return "disabled";
  try {
    await getApprovalNotificationQueue().add(
      "approval.notify",
      { stagingId: args.stagingId, userId: args.userId },
      {
        delay: Math.max(0, args.delayMs),
        jobId: approvalNotificationJobId(args.stagingId),
      },
    );
    return "scheduled";
  } catch (err) {
    console.warn(
      "[approvals] failed to schedule approval notification",
      args.stagingId,
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}

export async function removeApprovalNotificationJob(stagingId: string): Promise<void> {
  if (!isQueueEnabled()) return;
  try {
    const job = await getApprovalNotificationQueue().getJob(approvalNotificationJobId(stagingId));
    await job?.remove();
  } catch (err) {
    console.warn(
      "[approvals] failed to remove queued approval notification",
      stagingId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface StartApprovalNotificationWorkerOpts {
  concurrency?: number;
}

export async function startApprovalNotificationWorker(
  opts: StartApprovalNotificationWorkerOpts = {},
): Promise<void> {
  if (_worker) return;
  _worker = new Worker<ApprovalNotificationJobData>(
    APPROVAL_NOTIFICATION_QUEUE_NAME,
    processApprovalNotificationJob,
    {
      connection: createRedisConnection(),
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

export async function closeApprovalNotificationQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}

async function processApprovalNotificationJob(
  job: Job<ApprovalNotificationJobData>,
): Promise<unknown> {
  const { stagingId, userId } = approvalNotificationJobDataSchema.parse(job.data);
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

  const approvalUrl = approvalDeepLink(stagingId);
  const rendered = await renderApprovalNotification({
    stagingId,
    runId: row.runId,
    stepId: row.stepId,
    workflowSlug: row.workflowSlug,
    toolName: row.toolName,
    integration: row.integration,
    riskTier: row.riskTier,
    proposedInput: row.proposedInput,
    approvalUrl,
  });

  const result = await notify({
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
      proposedInput: row.proposedInput,
    },
  });

  // A failed send must NOT stamp notified_at (the guard on line 143 would then
  // block every future attempt) and must NOT complete the job green — throw so
  // BullMQ retries. notify() returns 'failed' instead of throwing, so re-raise
  // it here; the staging row stays 'pending' and the in-app /approvals fallback
  // is unaffected.
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
  toolName: string;
  integration: string;
  riskTier: string;
  proposedInput: unknown;
  approvalUrl: string;
}

async function renderApprovalNotification(args: RenderApprovalNotificationArgs): Promise<{
  subject: string;
  html: string;
  text: string;
}> {
  const action = humanizeToolName(args.toolName);
  const heading = `Alfred wants to ${action}`;
  const subject = `[${args.riskTier}] ${heading}`;
  const inputFields = summarizeInput(args.proposedInput);
  // Workflow / Tool / Risk lead the table, then the summarized input fields.
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

function webOrigin(): string {
  return serverEnv().CORS_ORIGIN.replace(/\/$/, "");
}

function approvalDeepLink(stagingId: string): string {
  return `${webOrigin()}/approvals#approval-${encodeURIComponent(stagingId)}`;
}

// Raster PNG, not SVG: Gmail/Outlook drop inline SVG <img> to alt text.
function emailLogoUrl(): string {
  return `${webOrigin()}/images/logo/alfred-logo-email.png`;
}

function summarizeInput(input: unknown): Array<{ label: string; value: string }> {
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
