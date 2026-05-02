/**
 * Smoke test for the m10 morning-briefing workflow.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-briefing.ts
 *
 * Pre-req: a server process running (`pnpm dev`) so the agent worker can
 * pick up the run. Resend must be configured (`RESEND_API_KEY`,
 * `RESEND_FROM_EMAIL`) and the user row must have a deliverable email
 * address.
 *
 * What this verifies end-to-end:
 *   1. enqueueBriefingRun creates a `morning-briefing` agent run pinned
 *      to a specific date and forces the send (bypassing the cron
 *      tz/hour gate).
 *   2. The workflow runs gather → compose → send to completion with a
 *      non-empty subject and idempotency key.
 *   3. An `email_sends` row lands at status='sent' with a Resend
 *      provider message id.
 *   4. Re-running the same date short-circuits to status='duplicate'
 *      (the unique index absorbs the second send).
 *
 * What this does NOT verify:
 *   - The hourly cron tick fires for the correct user (covered by the
 *     scheduled job; safe to inspect via `bullmq-dashboard` if needed).
 *   - Email is rendered as expected by Gmail/Outlook (visual check
 *     required — open the inbox).
 */
import {
  closeAgentQueue,
  closeBriefingQueue,
  closeConnections,
  closeRedis,
  enqueueBriefingRun,
  localDateInTimezone,
  resolveBriefingPreferences,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import { agentRuns, emailSends, user as userTable } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 60_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function pickUser() {
  const rows = await db()
    .select({ id: userTable.id, email: userTable.email, name: userTable.name })
    .from(userTable)
    .limit(1);
  return rows[0] ?? null;
}

async function pollRun(runId: string, label: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!row) throw new Error(`run ${runId} not found while waiting for ${label}`);
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return row;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

async function fetchEmailSend(userId: string, idempotencyKey: string) {
  const rows = await db()
    .select()
    .from(emailSends)
    .where(and(eq(emailSends.userId, userId), eq(emailSends.idempotencyKey, idempotencyKey)));
  return rows[0] ?? null;
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const u = await pickUser();
  if (!u) {
    console.log("[smoke-briefing] no user rows — sign in first.");
    return;
  }
  console.log(`[smoke-briefing] target: ${u.email} (id=${u.id})`);

  const prefs = await resolveBriefingPreferences(u.id);
  const briefingDate = localDateInTimezone(prefs.timezone);
  console.log(
    `[smoke-briefing] tz=${prefs.timezone} hour=${prefs.deliveryHour} date=${briefingDate} ` +
      `userOverride=${prefs.hasUserOverride}`,
  );

  // ---- Phase 1: enqueue forced run ----------------------------------------
  const { runId: runId1 } = await enqueueBriefingRun({
    userId: u.id,
    briefingDate,
    reason: "forced",
  });
  console.log(`[smoke-briefing] run 1 enqueued: ${runId1}`);

  const run1 = await pollRun(runId1, "run 1");
  assert(
    run1.status === "completed",
    `run 1 status=${run1.status} error=${JSON.stringify(run1.error)}`,
  );
  const out1 = run1.output as {
    emailSendId: string;
    status: "sent" | "duplicate";
    briefingDate: string;
  };
  console.log(
    `[smoke-briefing] run 1 output: status=${out1.status} emailSendId=${out1.emailSendId} ` +
      `briefingDate=${out1.briefingDate}`,
  );
  assert(
    out1.status === "sent" || out1.status === "duplicate",
    `unexpected run 1 status: ${out1.status}`,
  );

  // ---- Phase 2: verify email_sends row ------------------------------------
  const idempotencyKey = `briefing:${u.id}:${briefingDate}`;
  const send = await fetchEmailSend(u.id, idempotencyKey);
  assert(send, `no email_sends row for key=${idempotencyKey}`);
  console.log(
    `[smoke-briefing] email_sends row: id=${send.id} status=${send.status} ` +
      `subject=${JSON.stringify(send.subject)} resendId=${send.providerMessageId ?? "(none)"}`,
  );
  // First-run path: status should be `sent` if Resend went through.
  // If `duplicate`, a prior smoke run on this date already sent — that's
  // also a valid pass for the idempotency check on its own.
  if (out1.status === "sent") {
    assert(send.status === "sent", `expected email_sends.status=sent, got ${send.status}`);
    assert(
      send.providerMessageId,
      `expected providerMessageId after sent (Resend round-trip succeeded?)`,
    );
  }

  // ---- Phase 3: re-run; verify duplicate short-circuit --------------------
  const { runId: runId2 } = await enqueueBriefingRun({
    userId: u.id,
    briefingDate,
    reason: "forced",
  });
  console.log(`[smoke-briefing] run 2 enqueued: ${runId2}`);

  const run2 = await pollRun(runId2, "run 2");
  assert(run2.status === "completed", `run 2 status=${run2.status}`);
  const out2 = run2.output as { emailSendId: string; status: string };
  console.log(`[smoke-briefing] run 2 output: status=${out2.status} emailSendId=${out2.emailSendId}`);
  assert(
    out2.status === "duplicate",
    `expected run 2 to short-circuit as duplicate, got ${out2.status}`,
  );
  assert(
    out2.emailSendId === send.id,
    `run 2 returned different email_sends id: ${out2.emailSendId} vs ${send.id}`,
  );

  console.log("\n[smoke-briefing] PASS");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-briefing] FAIL",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeBriefingQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });
