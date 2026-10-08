/**
 * Workflow-blocked email (#561), one per blocker generation, on the approval notification queue.
 */

import { workflowBlockedGeneration } from "@alfred/contracts";
import { db } from "@alfred/db";
import { sha256Canonical } from "@alfred/db/hash";
import { workflows } from "@alfred/db/schemas";
import { renderWorkflowBlockedEmail } from "@alfred/mailer";
import { and, eq, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { send } from "@alfred/assistant/delivery";
import { emailLogoUrl, webOrigin } from "@alfred/assistant/settings";
import type { WorkflowBlockedNotificationJobData } from "@alfred/assistant/tool-runtime";

/** The page needs both search params to open the recovery panel. */
function workflowRecoveryDeepLink(slug: string, revisionId: string | undefined): string {
  const base = `${webOrigin()}/workflows/${encodeURIComponent(slug)}`;

  if (!revisionId) return base;
  const params = new URLSearchParams({ workflow_recovery: "1", revision_id: revisionId });

  return `${base}?${params.toString()}`;
}

/** A failed send throws so BullMQ retries; it is never returned. */
export type WorkflowBlockedNotificationResult =
  | { status: "missing"; workflowId: string }
  | {
      status: "skipped";
      reason: "unblocked" | "already_notified" | "superseded";
      workflowId: string;
    }
  | { status: "sent" | "duplicate"; workflowId: string; emailSendId: string };

export async function processWorkflowBlockedNotification(
  data: WorkflowBlockedNotificationJobData,
): Promise<WorkflowBlockedNotificationResult> {
  const [row] = await db()
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      blocked: workflows.blocked,
    })
    .from(workflows)
    .where(and(eq(workflows.id, data.workflowId), eq(workflows.userId, data.userId)))
    .limit(1);

  if (!row) return { status: "missing", workflowId: data.workflowId };
  const blocked = row.blocked;

  if (!blocked) return { status: "skipped", reason: "unblocked", workflowId: row.id };

  if (blocked.notifiedAt)
    return { status: "skipped", reason: "already_notified", workflowId: row.id };

  // The job names one blocker generation; a row that moved on belongs to a newer job.
  if (workflowBlockedGeneration(blocked) !== data.generation) {
    return { status: "skipped", reason: "superseded", workflowId: row.id };
  }

  const workflowUrl = workflowRecoveryDeepLink(row.slug, blocked.revisionId);
  const subject = `${row.name} is blocked`;

  const html = await renderWorkflowBlockedEmail({
    workflowName: row.name,
    message: blocked.message,
    code: blocked.code,
    workflowUrl,
    logoUrl: emailLogoUrl(),
  });

  const text = [
    subject,
    "",
    blocked.message,
    `Code: ${blocked.code}`,
    "",
    `Fix: ${workflowUrl}`,
  ].join("\n");

  const result = await send({
    userId: data.userId,
    kind: "workflow_blocked",
    idempotencyKey: `workflow_blocked:${row.id}:${sha256Canonical(data.generation).slice(7, 23)}`,
    subject,
    html,
    text,
    payload: {
      workflowId: row.id,
      workflowSlug: row.slug,
      revisionId: blocked.revisionId ?? null,
      code: blocked.code,
      message: blocked.message,
      workflowUrl,
    },
  });

  // Throw so BullMQ retries. A stamped `notifiedAt` would block every later attempt.
  if (result.status === "failed") {
    throw new Error(
      `[workflow-blocked-notification] send failed for workflow ${row.id}: ${result.error}`,
    );
  }

  const now = new Date();

  const updated = await db()
    .update(workflows)
    .set({
      blocked: { ...blocked, notifiedAt: now.toISOString() },
      rowVersion: sql`${workflows.rowVersion} + 1`,
    })
    .where(
      and(
        eq(workflows.id, row.id),
        eq(workflows.userId, data.userId),
        // jsonb equality is structural, so a changed or already stamped blocker does not match.
        sql`${workflows.blocked} = ${JSON.stringify(blocked)}::jsonb`,
      ),
    )
    .returning({ id: workflows.id });

  if (updated[0]) emitReplicachePokes([data.userId]);

  return { status: result.status, workflowId: row.id, emailSendId: result.emailSendId };
}
