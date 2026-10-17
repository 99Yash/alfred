// Waits for a pull request's checks to finish, and fails CLOSED while it waits.
//
// Agents wrote this poll loop by hand on every pull request, in three different
// forms, and one form ended a wait early: `gh pr checks N | grep -c pending`
// counts zero pending rows when `gh` fails with a network error, so the loop read
// "GitHub is unreachable" as "CI is done". This script is the one loop to use.
//
// What it treats as true:
//   - A `gh` failure (non-zero exit, a hung call, output that is not the expected
//     JSON) is never a verdict. It retries with backoff, and gives up with exit 2
//     after MAX_CONSECUTIVE_GH_FAILURES failures in a row.
//   - An empty check list means "not registered yet". `gh pr checks` reports it as
//     an error ("no checks reported"), so that one message is read as an empty
//     list, not as a failure. If the list stays empty past EMPTY_GRACE_SECONDS, the
//     script says so, and when the base branch is not `main` it exits 2: ci.yml
//     runs only for pull requests into `main`, so those checks never arrive.
//   - Green is "every check is in a final bucket and none is fail or cancel", seen
//     on two polls in a row while the PR is open. A job with `needs:`
//     (assistant-unit-tests needs its shards) is registered only after its needs
//     finish, so one all-final poll can come before that job exists.
//
// Exit codes: 0 every check passed or skipped; 1 a check failed or was cancelled;
// 2 the answer is unknown (bad usage, no such PR, gh kept failing, the wait timed
// out, or a non-main base registered no checks).
//
// Usage: node scripts/wait-pr-checks.mjs <pr-number> [--repo 99Yash/alfred]
//          [--interval 30] [--timeout 60] [--fail-fast]
//   --interval  seconds between polls (default 30)
//   --timeout   minutes before giving up with exit 2 (default 60)
//   --fail-fast exit 1 at the first failed check, without waiting for the rest

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const USAGE =
  "Usage: node scripts/wait-pr-checks.mjs <pr-number> [--repo 99Yash/alfred] [--interval 30] [--timeout 60] [--fail-fast]";

const DEFAULT_REPO = "99Yash/alfred";

const DEFAULT_INTERVAL_SECONDS = 30;

const DEFAULT_TIMEOUT_MINUTES = 60;

const MAX_CONSECUTIVE_GH_FAILURES = 5;

const MAX_BACKOFF_SECONDS = 300;

const EMPTY_GRACE_SECONDS = 180;

const GH_CALL_TIMEOUT_MS = 60_000;

const CHECK_FIELDS = "name,bucket,state,link,workflow";

const PR_FIELDS = "number,state,baseRefName,headRefName";

/** `gh pr checks --json` buckets. Only `pending` is not final. */
const FINAL_BUCKETS = new Set(["pass", "skipping", "fail", "cancel"]);

const RED_BUCKETS = new Set(["fail", "cancel"]);

const EXIT_GREEN = 0;

const EXIT_RED = 1;

const EXIT_UNKNOWN = 2;

/** `gh pr checks` exits 1 with this message when a PR has no checks yet. */
const NO_CHECKS_MESSAGE = /no checks reported/i;

/** `gh` exits 1 with this message for a PR number that does not exist. */
const NO_SUCH_PR_MESSAGE = /could not resolve to a pullrequest/i;

function stop(code, message) {
  if (message !== undefined) {
    (code === EXIT_GREEN ? console.log : console.error)(message);
  }

  process.exit(code);
}

function positiveNumber(flag, raw) {
  const value = Number(raw);

  if (raw === undefined || !Number.isFinite(value) || value <= 0) {
    stop(EXIT_UNKNOWN, `wait-pr-checks: ${flag} needs a positive number, got ${raw}.\n${USAGE}`);
  }

  return value;
}

function parseArgs(argv) {
  const options = {
    pr: null,
    repo: DEFAULT_REPO,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    failFast: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--repo" && argv[i + 1] !== undefined) {
      options.repo = argv[i + 1];
      i += 1;
    } else if (arg === "--interval") {
      options.intervalSeconds = positiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === "--timeout") {
      options.timeoutMinutes = positiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === "--fail-fast") {
      options.failFast = true;
    } else if (/^\d+$/.test(arg) && options.pr === null) {
      options.pr = arg;
    } else {
      stop(EXIT_UNKNOWN, `wait-pr-checks: unexpected argument ${JSON.stringify(arg)}.\n${USAGE}`);
    }
  }

  if (options.pr === null) stop(EXIT_UNKNOWN, `wait-pr-checks: a PR number is required.\n${USAGE}`);

  return options;
}

const options = parseArgs(process.argv.slice(2));

const deadline = Date.now() + options.timeoutMinutes * 60_000;

function clock() {
  return new Date().toISOString().slice(11, 19);
}

function log(line) {
  console.log(`[${clock()}] #${options.pr} ${line}`);
}

/** Runs `gh` with an argument array. Any outcome but exit 0 (or 8) is `ok: false`. */
function gh(args) {
  const run = spawnSync("gh", [...args, "--repo", options.repo], {
    encoding: "utf8",
    timeout: GH_CALL_TIMEOUT_MS,
  });

  if (run.error !== undefined) return { ok: false, stderr: "", reason: run.error.message };

  const stderr = run.stderr.trim();

  // 8 is gh's "checks pending" exit code. It still prints the JSON.
  if (run.status !== 0 && run.status !== 8) {
    const reason = stderr.split("\n")[0] || `exit ${run.status ?? run.signal}`;

    return { ok: false, stderr, reason: `gh exited ${run.status ?? run.signal}: ${reason}` };
  }

  try {
    return { ok: true, value: JSON.parse(run.stdout) };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");

    return { ok: false, stderr, reason: `gh printed output that is not JSON (${detail})` };
  }
}

function isRecord(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- walks gh --json output; an unknown shape fails closed
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record, key) {
  const value = record[key];

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- walks gh --json output; an unknown shape fails closed
  return typeof value === "string" ? value : null;
}

function readPr() {
  const read = gh(["pr", "view", options.pr, "--json", PR_FIELDS]);

  if (!read.ok) {
    if (NO_SUCH_PR_MESSAGE.test(read.stderr)) {
      stop(EXIT_UNKNOWN, `wait-pr-checks: PR #${options.pr} does not exist in ${options.repo}.`);
    }

    return read;
  }

  const pr = read.value;

  const state = isRecord(pr) ? stringField(pr, "state") : null;

  const base = isRecord(pr) ? stringField(pr, "baseRefName") : null;

  if (state === null || base === null) {
    return { ok: false, reason: `gh pr view printed ${JSON.stringify(pr)}, not a pull request` };
  }

  return { ok: true, value: { state, base } };
}

function readChecks() {
  const read = gh(["pr", "checks", options.pr, "--json", CHECK_FIELDS]);

  if (!read.ok) return NO_CHECKS_MESSAGE.test(read.stderr) ? { ok: true, value: [] } : read;

  if (!Array.isArray(read.value)) {
    return { ok: false, reason: `gh pr checks printed ${JSON.stringify(read.value)}, not a list` };
  }

  const checks = [];

  for (const row of read.value) {
    const name = isRecord(row) ? stringField(row, "name") : null;

    const bucket = isRecord(row) ? stringField(row, "bucket") : null;

    if (name === null || bucket === null) {
      return {
        ok: false,
        reason: `gh pr checks printed a row without name/bucket: ${JSON.stringify(row)}`,
      };
    }

    checks.push({
      name,
      bucket,
      link: stringField(row, "link") ?? "",
      workflow: stringField(row, "workflow") ?? "",
    });
  }

  return { ok: true, value: checks };
}

/**
 * Calls `read` until it succeeds. A failure is retried with exponential backoff
 * and never returned, so no caller can mistake it for an answer.
 */
async function untilRead(read) {
  for (let failures = 1; ; failures += 1) {
    const result = read();

    if (result.ok) return result.value;

    if (failures >= MAX_CONSECUTIVE_GH_FAILURES) {
      stop(
        EXIT_UNKNOWN,
        `wait-pr-checks: gh failed ${failures} times in a row; the check state is unknown, not done.\n  last error: ${result.reason}`,
      );
    }

    const backoff = Math.min(options.intervalSeconds * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);

    log(
      `gh failed (${failures}/${MAX_CONSECUTIVE_GH_FAILURES}): ${result.reason}; retrying in ${backoff}s`,
    );
    await waitOrTimeOut(backoff);
  }
}

async function waitOrTimeOut(seconds) {
  if (Date.now() + seconds * 1000 > deadline) {
    stop(
      EXIT_UNKNOWN,
      `wait-pr-checks: timed out after ${options.timeoutMinutes} min with checks unfinished.`,
    );
  }

  await sleep(seconds * 1000);
}

function summary(checks) {
  const counts = new Map();

  for (const check of checks) counts.set(check.bucket, (counts.get(check.bucket) ?? 0) + 1);

  const parts = [...counts].map(([bucket, count]) => `${count} ${bucket}`).join(", ");

  const pending = checks
    .filter((check) => !FINAL_BUCKETS.has(check.bucket))
    .map((check) => check.name);

  const shown = pending.slice(0, 3).join(", ") + (pending.length > 3 ? ", ..." : "");

  return `${checks.length} checks: ${parts}${pending.length > 0 ? ` (waiting on ${shown})` : ""}`;
}

function failRed(red) {
  console.error(`\nwait-pr-checks: ${red.length} check(s) failed on PR #${options.pr}:`);

  for (const check of red) {
    const workflow = check.workflow === "" ? "" : ` [${check.workflow}]`;

    console.error(`  ${check.bucket.toUpperCase()} ${check.name}${workflow} ${check.link}`);
  }

  stop(EXIT_RED);
}

const pr = await untilRead(readPr);

const stackedNote =
  pr.base === "main"
    ? null
    : `base branch is ${pr.base}, not main: ci.yml runs only for pull requests into main, so these checks do not include it.`;

if (stackedNote !== null) log(`WARNING: ${stackedNote}`);

let emptySince = null;

let emptyReported = false;

let allFinalBefore = -1;

for (;;) {
  const checks = await untilRead(readChecks);

  if (checks.length === 0) {
    emptySince ??= Date.now();

    const emptySeconds = Math.round((Date.now() - emptySince) / 1000);

    log(`no checks registered yet (${emptySeconds}s)`);

    if (emptySeconds >= EMPTY_GRACE_SECONDS && !emptyReported) {
      emptyReported = true;

      if (stackedNote !== null) {
        stop(
          EXIT_UNKNOWN,
          `wait-pr-checks: no checks after ${emptySeconds}s, and the ${stackedNote}`,
        );
      }

      log(
        `no checks after ${EMPTY_GRACE_SECONDS}s; still waiting. Check that the push reached GitHub.`,
      );
    }

    await waitOrTimeOut(options.intervalSeconds);
    continue;
  }

  emptySince = null;
  log(summary(checks));

  const red = checks.filter((check) => RED_BUCKETS.has(check.bucket));

  if (options.failFast && red.length > 0) failRed(red);

  const allFinal = checks.every((check) => FINAL_BUCKETS.has(check.bucket));

  // A merged or closed PR registers no new jobs, so one all-final poll settles it.
  const settled = allFinal && (pr.state !== "OPEN" || allFinalBefore === checks.length);

  if (settled) {
    if (red.length > 0) failRed(red);

    const tail = stackedNote === null ? "" : `\nWARNING: ${stackedNote}`;

    stop(
      EXIT_GREEN,
      `wait-pr-checks: all ${checks.length} checks on PR #${options.pr} passed or skipped.${tail}`,
    );
  }

  if (allFinal)
    log("every check is final; confirming on the next poll that no job is still to register");

  allFinalBefore = allFinal ? checks.length : -1;
  await waitOrTimeOut(options.intervalSeconds);
}
