/**
 * Smoke test for the daily-briefing workflow: one `dump_briefing` call, a
 * `briefings` row (`composed` with --no-send, else `sent`), and an `email_sends` row.
 *
 *   # Morning slot only (default):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-daily-briefing.ts
 *
 *   # Specific slot, compose only (no Resend send):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-daily-briefing.ts \
 *       --slot=evening --no-send
 *
 *   # Pin a specific user (multi-user dev DB):
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-daily-briefing.ts \
 *       --email=iamdevyash@gmail.com
 *
 * Pre-reqs:
 *   - Server worker running (`pnpm dev`).
 *   - `OPENAI_API_KEY` set.
 *   - User row with a deliverable email (only when sending).
 */
import { randomUUID } from "node:crypto";
import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  resolveBriefingPreferences,
  closeBriefingQueue,
} from "@alfred/assistant/briefings";
import { inZone } from "@alfred/assistant/time";
import { startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { warmPool } from "@alfred/db";
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
  const briefingDate = inZone(prefs.timezone).day();
  console.log(
    `[smoke-daily-briefing] tz=${prefs.timezone} morningHour=${prefs.deliveryHour} ` +
      `eveningHour=${prefs.eveningHour} date=${briefingDate}`,
  );

  const { runId } = await startRun({
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
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

  console.log(`[smoke-daily-briefing] run enqueued: ${runId}`);

  const run = await pollRun(runId, "compose");

  if (run.status !== "completed") {
    console.error(`[smoke-daily-briefing] run failed: ${JSON.stringify(run.error)}`);
    throw new Error(`run status=${run.status}`);
  }

  // SAFETY: the briefing workflow's own output shape.
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

  // A forced run never suppresses.
  const expectedRowStatus = cli.noSend ? "composed" : "sent";
  const row = await fetchBriefing(output.briefingId);
  assert(row, `briefings row not found: ${output.briefingId}`);
  assert(
    row.status === expectedRowStatus,
    `expected status=${expectedRowStatus}, got ${row.status}`,
  );
  assert(row.fullBriefing?.headline, "briefings.full_briefing.headline is empty");
  assert(row.breakingSummary, "briefings.breaking_summary is empty");

  // A --no-send 'composed' row leaves the watermark null, so the next real run replays the delta.
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
