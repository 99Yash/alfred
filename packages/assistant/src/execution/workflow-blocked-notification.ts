/**
 * Workflow-blocked notification (#561) — worker side.
 *
 * `checkWorkflowRunReadiness` enqueues one job per new blocker generation on
 * the approval notification queue. When it fires, re-read the workflow; if the
 * same blocker is still current and has not been notified, render the email,
 * hand it to `delivery.send`, stamp `blocked.notifiedAt` guarded on the same
 * generation, and poke Replicache. A failed send throws so BullMQ retries.
 *
 * Lives in `execution` beside the approval worker for the same reason: it
 * imports `../delivery` (the sender), which `tool-runtime` must not.
 */

import { db } from "@alfred/db";
import { workflows } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { renderWorkflowBlockedEmail } from "@alfred/mailer";
import { and, eq, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { send } from "@alfred/assistant/delivery";
import type { WorkflowBlockedNotificationJobData } from "@alfred/assistant/tool-runtime";

export function webOrigin(): string {
  return serverEnv().CORS_ORIGIN.replace(/\/$/, "");
}

// Raster PNG, not SVG: Gmail/Outlook drop inline SVG <img> to alt text.
export function emailLogoUrl(): string {
  return `${webOrigin()}/images/logo/alfred-logo-email.png`;
}

/** Opens the workflow page with the recovery panel for the blocked revision. */
function workflowRecoveryDeepLink(slug: string, revisionId: string): string {
  const params = new URLSearchParams({ workflow_recovery: "1", revision_id: revisionId });
  return `${webOrigin()}/workflows/${encodeURIComponent(slug)}?${params.toString()}`;
}

export async function processWorkflowBlockedNotification(
  data: WorkflowBlockedNotificationJobData,
): Promise<unknown> {
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
  if (blocked.code !== data.code || (blocked.revisionId ?? data.revisionId) !== data.revisionId) {
    return { status: "skipped", reason: "superseded", workflowId: row.id };
  }

  const workflowUrl = workflowRecoveryDeepLink(row.slug, data.revisionId);
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
    idempotencyKey: `workflow_blocked:${row.id}:${data.revisionId}:${blocked.code}`,
    subject,
    html,
    text,
    payload: {
      workflowId: row.id,
      workflowSlug: row.slug,
      revisionId: data.revisionId,
      code: blocked.code,
      message: blocked.message,
      workflowUrl,
    },
  });

  // A failed send must NOT stamp notifiedAt (the guard above would then block
  // every future attempt) and must NOT complete the job green — throw so BullMQ
  // retries. The workflow stays blocked either way.
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
        // Guard on the same generation: a blocker that changed between the
        // read above and this write belongs to a newer job.
        sql`${workflows.blocked} ->> 'code' = ${blocked.code}`,
        sql`coalesce(${workflows.blocked} ->> 'revisionId', ${data.revisionId}) = ${data.revisionId}`,
        sql`${workflows.blocked} ->> 'notifiedAt' is null`,
      ),
    )
    .returning({ id: workflows.id });

  if (updated[0]) emitReplicachePokes([data.userId]);
  return { status: result.status, workflowId: row.id, emailSendId: result.emailSendId };
}
