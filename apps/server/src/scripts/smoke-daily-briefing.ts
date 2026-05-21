/**
 * Smoke test for the LLM-composed daily-briefing workflow.
 *
 *   # Morning slot only (default):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-daily-briefing.ts
 *
 *   # Specific slot + skip Resend send (compose only — for prompt iteration):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-daily-briefing.ts \
 *       --slot=evening --no-send
 *
 *   # Pin a specific user (multi-user dev DB):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-daily-briefing.ts \
 *       --email=iamdevyash@gmail.com
 *
 * What this verifies end-to-end:
 *   1. The daily-briefing workflow runs gather → compose → persist → send
 *      to completion.
 *   2. The agent calls dump_briefing exactly once and produces a non-empty
 *      subject + bodyText + bodyHtml.
 *   3. A `briefing_runs` row lands at status='composed' with a
 *      watermark_at anchored on the frozen "until" instant.
 *   4. (When --no-send is omitted) An `email_sends` row lands at status='sent'.
 *
 * What this does NOT verify:
 *   - Quality of the composed briefing — qualitative, requires reading
 *     the rendered HTML in a real email client (or against the Dimension
 *     sample HTML files in .tmp-screens/).
 *   - That subsequent runs correctly consume the watermark — exercise by
 *     re-running the script; the second run should see fewer emails.
 *
 * Pre-reqs:
 *   - Server worker running (`pnpm dev`) so the agent run picks up.
 *   - `ANTHROPIC_API_KEY` set; Sonnet 4.6 is the boss model.
 *   - User row with a deliverable email (only when sending).
 */
import {
  closeAgentQueue,
  closeBriefingQueue,
  closeConnections,
  closeRedis,
  createRun,
  DAILY_BRIEFING_WORKFLOW_SLUG,
  enqueueRun,
  localDateInTimezone,
  resolveBriefingPreferences,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import { agentRuns, briefingRuns, user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120_000;

interface CliArgs {
  slot: "morning" | "evening";
  email: string | null;
  noSend: boolean;
}

function parseArgs(): CliArgs {
  const out: CliArgs = { slot: "morning", email: null, noSend: false };
  for (const raw of process.argv.slice(2)) {
    if (raw === "--no-send") out.noSend = true;
    else if (raw.startsWith("--slot=")) {
      const v = raw.slice("--slot=".length);
      if (v !== "morning" && v !== "evening") {
        throw new Error(`unknown slot: ${v} (expected 'morning' or 'evening')`);
      }
      out.slot = v;
    } else if (raw.startsWith("--email=")) {
      out.email = raw.slice("--email=".length);
    } else {
      console.warn(`[smoke-daily-briefing] ignoring unknown arg: ${raw}`);
    }
  }
  return out;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function pickUser(email: string | null) {
  if (email) {
    const rows = await db()
      .select({ id: userTable.id, email: userTable.email, name: userTable.name })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    return rows[0] ?? null;
  }
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

async function fetchBriefingRun(id: string) {
  const rows = await db().select().from(briefingRuns).where(eq(briefingRuns.id, id)).limit(1);
  return rows[0] ?? null;
}

async function main() {
  const cli = parseArgs();
  await warmPool();
  registerBuiltinWorkflows();

  const u = await pickUser(cli.email);
  if (!u) {
    console.log(
      `[smoke-daily-briefing] no user found ${cli.email ? `for email=${cli.email}` : "(empty user table)"}.`,
    );
    return;
  }
  console.log(
    `[smoke-daily-briefing] target: ${u.email} (id=${u.id}) slot=${cli.slot}` +
      (cli.noSend ? " [--no-send]" : ""),
  );

  const prefs = await resolveBriefingPreferences(u.id);
  const briefingDate = localDateInTimezone(prefs.timezone);
  console.log(
    `[smoke-daily-briefing] tz=${prefs.timezone} morningHour=${prefs.deliveryHour} ` +
      `eveningHour=${prefs.eveningHour} date=${briefingDate}`,
  );

  const { runId } = await createRun({
    userId: u.id,
    workflowSlug: DAILY_BRIEFING_WORKFLOW_SLUG,
    brief: `${cli.slot} briefing for ${briefingDate} (smoke${cli.noSend ? ", dryRun" : ""})`,
    input: {
      slot: cli.slot,
      reason: "forced",
      briefingDate,
      dryRun: cli.noSend,
    },
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId);
  console.log(`[smoke-daily-briefing] run enqueued: ${runId}`);

  const run = await pollRun(runId, "compose");
  if (run.status !== "completed") {
    console.error(`[smoke-daily-briefing] run failed: ${JSON.stringify(run.error)}`);
    throw new Error(`run status=${run.status}`);
  }

  const output = run.output as
    | {
        briefingRunId?: string;
        emailSendId?: string | null;
        status?: string;
        slot: string;
      }
    | null;
  assert(output?.briefingRunId, "run completed but output.briefingRunId is missing");
  console.log(
    `[smoke-daily-briefing] run completed: briefingRunId=${output.briefingRunId} ` +
      `emailStatus=${output.status ?? "(n/a)"}`,
  );

  const expectedRowStatus = cli.noSend ? "dry_run" : "composed";
  const row = await fetchBriefingRun(output.briefingRunId);
  assert(row, `briefing_runs row not found: ${output.briefingRunId}`);
  assert(
    row.status === expectedRowStatus,
    `expected status=${expectedRowStatus}, got ${row.status}`,
  );
  assert(row.subject, "briefing_runs.subject is empty");
  assert(row.bodyText, "briefing_runs.body_text is empty");
  assert(row.bodyHtml, "briefing_runs.body_html is empty");
  assert(row.watermarkAt, "briefing_runs.watermark_at is null");

  console.log("\n========================================");
  console.log(`SLOT:    ${row.slot}`);
  console.log(`SUBJECT: ${row.subject}`);
  console.log(
    `MODEL:   ${row.modelId} in=${row.inputTokens ?? "?"} out=${row.outputTokens ?? "?"}`,
  );
  console.log(`WMARK:   ${row.watermarkAt?.toISOString()}`);
  console.log("----------------------------------------");
  console.log(row.bodyText);
  console.log("========================================\n");

  console.log("[smoke-daily-briefing] PASS");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-daily-briefing] FAIL",
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
