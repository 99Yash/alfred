import { db } from "@alfred/db";
import { actionStagings, agentRuns } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, eq, sql } from "drizzle-orm";
import { Queue, Worker, type Job } from "bullmq";
import { emitReplicachePokes } from "../../events/replicache-events";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";
import { notify } from "../notifications";

export const APPROVAL_NOTIFICATION_QUEUE_NAME = "staging-notify";

export interface ApprovalNotificationJobData {
  stagingId: string;
  userId: string;
}

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
  const { stagingId, userId } = job.data;
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
  const rendered = renderApprovalNotification({
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

function renderApprovalNotification(args: RenderApprovalNotificationArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const action = humanizeToolName(args.toolName);
  const subject = `[${args.riskTier}] Alfred wants to ${action}`;
  const fields = summarizeInput(args.proposedInput);
  const textLines = [
    subject,
    "",
    `Workflow: ${args.workflowSlug}`,
    `Tool: ${args.toolName}`,
    `Risk: ${args.riskTier}`,
    `Run: ${args.runId}`,
    `Step: ${args.stepId}`,
    "",
    "Key fields:",
    ...fields.map((f) => `- ${f.label}: ${f.value}`),
    "",
    `Review: ${args.approvalUrl}`,
  ];

  const htmlFields = fields
    .map(
      (f) =>
        `<tr><th align="left" style="padding:6px 12px 6px 0;color:#6b7280;font-weight:500;">${escapeHtml(f.label)}</th><td style="padding:6px 0;color:#111827;">${escapeHtml(f.value)}</td></tr>`,
    )
    .join("");
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;color:#111827;">
      <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(subject)}</h1>
      <p style="margin:0 0 16px;color:#374151;">A workflow paused for your approval before taking this action.</p>
      <table style="border-collapse:collapse;margin:0 0 16px;">
        <tr><th align="left" style="padding:6px 12px 6px 0;color:#6b7280;font-weight:500;">Workflow</th><td style="padding:6px 0;">${escapeHtml(args.workflowSlug)}</td></tr>
        <tr><th align="left" style="padding:6px 12px 6px 0;color:#6b7280;font-weight:500;">Tool</th><td style="padding:6px 0;">${escapeHtml(args.toolName)}</td></tr>
        <tr><th align="left" style="padding:6px 12px 6px 0;color:#6b7280;font-weight:500;">Risk</th><td style="padding:6px 0;">${escapeHtml(args.riskTier)}</td></tr>
        ${htmlFields}
      </table>
      <p style="margin:0;">
        <a href="${escapeHtml(args.approvalUrl)}" style="display:inline-block;border-radius:999px;background:#4f37cb;color:#ffffff;text-decoration:none;padding:10px 16px;font-weight:600;">Review in Alfred</a>
      </p>
      <p style="margin:16px 0 0;color:#6b7280;font-size:12px;">Run ${escapeHtml(args.runId)} · staging ${escapeHtml(args.stagingId)}</p>
    </div>
  `;

  return { subject, html, text: textLines.join("\n") };
}

function approvalDeepLink(stagingId: string): string {
  const origin = serverEnv().CORS_ORIGIN.replace(/\/$/, "");
  return `${origin}/approvals#approval-${encodeURIComponent(stagingId)}`;
}

function humanizeToolName(toolName: string): string {
  const [integration, action] = toolName.split(".");
  const cleanIntegration = humanize(integration ?? "tool");
  const cleanAction = humanize(action ?? toolName);
  if (integration === "gmail" && action === "send_draft") return "send a Gmail draft";
  if (integration === "gmail" && action === "search") return "search Gmail";
  if (integration === "calendar" && action === "create_event") return "create a calendar event";
  if (integration === "calendar" && action === "list_events") return "list calendar events";
  return `${cleanAction} in ${cleanIntegration}`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function summarizeInput(input: unknown): Array<{ label: string; value: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [{ label: "Input", value: truncate(formatValue(input), 500) }];
  }
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 8);
  if (entries.length === 0) return [{ label: "Input", value: "{}" }];
  return entries.map(([key, value]) => ({
    label: humanize(key),
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
