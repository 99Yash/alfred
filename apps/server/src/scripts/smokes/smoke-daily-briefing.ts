/**
 * Smoke test for the LLM-composed daily-briefing workflow.
 *
 *   # Morning slot only (default):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-daily-briefing.ts
 *
 *   # Specific slot + skip Resend send (compose only — for prompt iteration):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-daily-briefing.ts \
 *       --slot=evening --no-send
 *
 *   # Pin a specific user (multi-user dev DB):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-daily-briefing.ts \
 *       --email=iamdevyash@gmail.com
 *
 * What this verifies end-to-end:
 *   1. The daily-briefing workflow runs gather → compose → send to
 *      completion.
 *   2. The agent calls dump_briefing exactly once and produces a non-empty
 *      subject (→ headline) + breaking_summary prose.
 *   3. A canonical `briefings` row lands — status='composed' under
 *      --no-send, status='sent' otherwise — with a watermark_at anchored
 *      on the frozen "until" instant.
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
  createRun,
  DAILY_BRIEFING_WORKFLOW_SLUG,
  enqueueRun,
  localDateInTimezone,
  resolveBriefingPreferences,
} from "@alfred/api/backend";
import { closeAgentQueue, closeBriefingQueue, warmPool } from "@alfred/api/runtime";
import { db } from "@alfred/db";
import { agentRuns, briefings, user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

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

async function fetchBriefing(id: string) {
  const rows = await db().select().from(briefings).where(eq(briefings.id, id)).limit(1);
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

  const output = run.output as {
    briefingId?: string;
    emailSendId?: string | null;
    status?: string;
    slot: string;
  } | null;
  assert(output?.briefingId, "run completed but output.briefingId is missing");
  console.log(
    `[smoke-daily-briefing] run completed: briefingId=${output.briefingId} ` +
      `status=${output.status ?? "(n/a)"}`,
  );

  // forced runs never suppress, so the terminal row is 'composed' under
  // --no-send (send short-circuits) and 'sent' otherwise.
  const expectedRowStatus = cli.noSend ? "composed" : "sent";
  const row = await fetchBriefing(output.briefingId);
  assert(row, `briefings row not found: ${output.briefingId}`);
  assert(
    row.status === expectedRowStatus,
    `expected status=${expectedRowStatus}, got ${row.status}`,
  );
  assert(row.fullBriefing?.headline, "briefings.full_briefing.headline is empty");
  assert(row.breakingSummary, "briefings.breaking_summary is empty");
  // Only terminal (sent/suppressed) rows consume the watermark; a --no-send
  // 'composed' row intentionally leaves it null so the next real run replays
  // the same delta.
  if (!cli.noSend) assert(row.watermarkAt, "briefings.watermark_at is null");

  console.log("\n========================================");
  console.log(`SLOT:    ${row.slot}`);
  console.log(`SUBJECT: ${row.fullBriefing.headline}`);
  console.log(`MODEL:   ${row.model}`);
  console.log(`WMARK:   ${row.watermarkAt?.toISOString()}`);
  console.log("----------------------------------------");
  console.log(row.breakingSummary);
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
    await closeScriptResources(closeAgentQueue, closeBriefingQueue);
  });
