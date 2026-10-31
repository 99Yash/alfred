#!/usr/bin/env node
/**
 * The two jobs a campaign orchestrator repeats by hand, as one command each.
 *
 *   campaign-ops.mjs status <slug>
 *   campaign-ops.mjs merge  <slug> <id> [--wait <minutes>]
 *
 * `status` prints the items that are not done (phase, round, PR, draft or ready, CI
 * buckets), the live lanes that `campaign.sh` registered under `.campaign/<slug>/lanes/`
 * (item, phase, age of the last stream output, age of the newest log), and any
 * `campaign.sh` process that has no lane file. It writes nothing.
 *
 * `merge` merges one landed item and refuses at the first gate that fails:
 *   1. the item is `landed`, its PR is open and out of draft;
 *   2. the PR head equals the remote branch tip and the worktree HEAD, and the worktree
 *      is clean;
 *   3. CI is green by `scripts/wait-pr-checks.mjs` (it waits up to `--wait` minutes);
 *   4. `gh pr merge --squash --match-head-commit <head>`, so GitHub merges that head only;
 *   5. the squash patch equals the branch patch. Equal text is `PATCH-SAME`. Equal
 *      changed lines with different context (the base moved under the branch) is
 *      `PATCH-SAME-LINES`. Anything else is `PATCH-DIFF`: the worktree stays, and the
 *      command exits 1;
 *   6. it removes the worktree, sets the item's `worktree` and `note`, and writes the
 *      NOTES.md line.
 * It never passes `--admin`, and it refuses the flag when you give it.
 *
 * State and NOTES writes go through `campaign-state.mjs`, so they take the same lock as
 * every phase. One orchestrator session made about 2,500 tool calls on these two jobs
 * (294 lane polls, 57 merges, 90 patch compares), and this file replaces them.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_SCRIPT = join(import.meta.dirname, "campaign-state.mjs");

const WAIT_SCRIPT = join(import.meta.dirname, "wait-pr-checks.mjs");

const DEFAULT_WAIT_MINUTES = 5;

/** The same default as `STALE_OUTPUT_SECONDS` in `campaign.sh`. */
const STALE_OUTPUT_SECONDS = Number(process.env.STALE_OUTPUT_SECONDS ?? 1200);

const DONE_PHASES = ["landed", "skipped"];

const ADMIN_REFUSAL =
  "campaign-ops refuses --admin. Wait with `node scripts/wait-pr-checks.mjs <n>` and fix the red check. The owner merges past red by hand.";

/** @returns {never} */
function die(message) {
  process.stderr.write(`campaign-ops: ${message}\n`);
  process.exit(1);
}

/** Runs a command and returns its trimmed stdout, or dies with its stderr. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });

  if (result.error !== undefined) die(`${command} ${args.join(" ")}: ${result.error.message}`);

  if (result.status !== 0) {
    die(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

/** Like `run`, but a failure returns `null` for the caller to report. */
function tryRun(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });

  if (result.error !== undefined || result.status !== 0) return null;

  return result.stdout.trim();
}

/**
 * The main checkout, from any worktree. `.campaign/` lives only there, and
 * `--show-toplevel` in a worktree names the worktree.
 */
function mainRoot() {
  const commonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();

  return dirname(commonDir);
}

/**
 * Reads one field of parsed JSON from `gh` or a lane file. Any other shape reads as
 * `undefined`, so a changed `gh` output fails the caller's literal comparison.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readField(value, key) {
  return value instanceof Object ? Reflect.get(value, key) : undefined;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string | null}
 */
function stringField(value, key) {
  const field = readField(value, key);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- walks gh --json output; an unknown shape fails closed
  return typeof field === "string" ? field : null;
}

/** @returns {unknown} */
function ghJson(args, cwd) {
  const out = tryRun("gh", args, cwd);

  if (out === null) return null;

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function campaignPaths(slug) {
  if (!slug || !/^[\w.-]+$/.test(slug)) die("pass a campaign slug, for example type-flow-20261025");
  const root = mainRoot();
  const dir = join(root, ".campaign", slug);
  const statePath = join(dir, "state.json");

  if (!existsSync(statePath)) die(`no campaign at ${statePath}`);

  return { root, dir, statePath };
}

/** The whole state, read through `campaign-state.mjs get`. */
function readState(statePath, root) {
  const state = JSON.parse(
    run(process.execPath, [STATE_SCRIPT, "get", "--state", statePath], root),
  );

  const items = readField(state, "items");

  if (!Array.isArray(items)) die(`${statePath} has no items array`);

  return { state, items };
}

function stateWrite(root, args) {
  return run(process.execPath, [STATE_SCRIPT, ...args], root);
}

function age(ms) {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;

  if (minutes < 60) return `${minutes}m`;

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function mtimeAge(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// --- status ---------------------------------------------------------------

/** Counts `gh pr checks` buckets, the same buckets `wait-pr-checks.mjs` reads. */
function ciBuckets(pr, root) {
  const checks = ghJson(["pr", "checks", String(pr), "--json", "bucket"], root);

  if (!Array.isArray(checks)) return "ci ?";
  const counts = new Map();

  for (const check of checks) {
    const bucket = stringField(check, "bucket") ?? "?";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  if (counts.size === 0) return "ci none";

  return [...counts].map(([bucket, count]) => `${bucket} ${count}`).join(", ");
}

/** Open PRs by number, read in one call. */
function openPrs(root) {
  const prs = ghJson(
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,isDraft"],
    root,
  );

  if (!Array.isArray(prs)) return null;

  return new Map(
    prs.map((pr) => [Number(readField(pr, "number")), readField(pr, "isDraft") === true]),
  );
}

function newestLog(dir, itemId) {
  const logsDir = join(dir, "logs");

  if (!existsSync(logsDir)) return null;
  const suffix = `-${itemId}.log`;
  /** @type {{ name: string, ms: number } | null} */
  let newest = null;

  for (const name of readdirSync(logsDir)) {
    if (!name.endsWith(suffix)) continue;
    const ms = mtimeAge(join(logsDir, name));

    if (ms !== null && (newest === null || ms < newest.ms)) newest = { name, ms };
  }

  return newest;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * `campaign.sh` driver processes, by pid, from `ps`. A subshell of a driver (its
 * watchdog) shows the same command line, so a process whose parent is also a driver
 * is left out.
 */
function driverPids() {
  const out = tryRun("ps", ["-axo", "pid=,ppid=,command="]) ?? "";
  const parents = new Map();

  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

    if (match && /\bcampaign\.sh\b/.test(match[3])) parents.set(Number(match[1]), Number(match[2]));
  }

  return new Set([...parents].filter(([, ppid]) => !parents.has(ppid)).map(([pid]) => pid));
}

function printLanes(dir) {
  const lanesDir = join(dir, "lanes");
  const drivers = driverPids();
  const seen = new Set();
  const lines = [];

  if (existsSync(lanesDir)) {
    for (const name of readdirSync(lanesDir)
      .filter((one) => one.endsWith(".json"))
      .toSorted()) {
      let lane;

      try {
        lane = JSON.parse(readFileSync(join(lanesDir, name), "utf8"));
      } catch {
        lines.push(`  ${name}: unreadable lane file`);
        continue;
      }

      const pid = Number(readField(lane, "pid"));
      seen.add(pid);
      const item = stringField(lane, "item") ?? "?";
      const where = `item ${item} ${stringField(lane, "phase") ?? "?"} r${stringField(lane, "round") ?? "?"}`;

      if (!isAlive(pid) || !drivers.has(pid)) {
        lines.push(`  pid ${pid} · ${where} · DEAD (lane file left behind: ${name})`);
        continue;
      }

      const heartbeat = stringField(lane, "heartbeat");
      const quiet = heartbeat === null ? null : mtimeAge(heartbeat);
      const started = Date.parse(stringField(lane, "startedAt") ?? "");
      const log = newestLog(dir, item);
      const stale = quiet !== null && quiet >= STALE_OUTPUT_SECONDS * 1000 ? " · STALE" : "";
      lines.push(
        `  pid ${pid} · ${where} · ${stringField(lane, "engine") ?? "?"}` +
          ` · phase ${Number.isNaN(started) ? "?" : age(Date.now() - started)}` +
          ` · last output ${quiet === null ? "?" : `${age(quiet)} ago`}` +
          ` · log ${log === null ? "none" : `${log.name} ${age(log.ms)} ago`}${stale}`,
      );
    }
  }

  for (const pid of drivers) {
    if (!seen.has(pid))
      lines.push(
        `  pid ${pid} · campaign.sh with no lane file (another campaign, or an older driver)`,
      );
  }

  process.stdout.write(`lanes:\n${lines.length === 0 ? "  none\n" : `${lines.join("\n")}\n`}`);
}

function commandStatus(slug) {
  const { root, dir, statePath } = campaignPaths(slug);
  const { state, items } = readState(statePath, root);
  const counts = new Map();

  for (const item of items) {
    const phase = stringField(item, "phase") ?? "?";
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }

  const frozen = readField(readField(state, "policy"), "queueFrozen") === true;
  process.stdout.write(
    `campaign ${slug} · ${items.length} items · ${[...counts].map(([p, n]) => `${p} ${n}`).join(", ")}` +
      `${frozen ? " · queue frozen" : ""}\n`,
  );

  const open = openPrs(root);

  if (open === null) process.stdout.write("gh pr list failed: PR and CI columns are unknown\n");
  const rows = [];

  for (const item of items) {
    const phase = stringField(item, "phase") ?? "?";
    const pr = Number(readField(item, "pr"));
    const hasPr = Number.isInteger(pr) && pr > 0;
    const prOpen = hasPr && open !== null && open.has(pr);

    // A landed item stays on the list while its PR is open: it waits for `merge`.
    if (DONE_PHASES.includes(phase) && !(phase === "landed" && prOpen)) continue;
    let prCell = "-";

    if (hasPr) {
      if (open === null) prCell = `#${pr} ?`;
      else if (prOpen)
        prCell = `#${pr} ${open.get(pr) ? "draft" : "ready"} · ${ciBuckets(pr, root)}`;
      else prCell = `#${pr} closed or merged`;
    }

    const note = (stringField(item, "note") ?? "").slice(0, 90);
    rows.push(
      `  ${String(stringField(item, "id")).padEnd(4)}${phase.padEnd(12)}r${String(Number(readField(item, "round") ?? 0)).padEnd(3)}${prCell}${note ? `  — ${note}` : ""}`,
    );
  }

  process.stdout.write(`not done:\n${rows.length === 0 ? "  none\n" : `${rows.join("\n")}\n`}`);
  printLanes(dir);
}

// --- merge ----------------------------------------------------------------

function parseMergeFlags(argv) {
  let wait = DEFAULT_WAIT_MINUTES;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wait") {
      wait = Number(argv[i + 1]);

      if (!Number.isFinite(wait) || wait <= 0) die("--wait needs a positive number of minutes");
      i += 1;
    } else {
      die(`unexpected argument ${argv[i]}`);
    }
  }

  return { wait };
}

/** A diff with hunk headers and blob ids removed, so only the changed lines remain. */
function changedLines(root, from, to) {
  return run("git", ["diff", "-U0", "--no-color", from, to], root)
    .split("\n")
    .filter((line) => !line.startsWith("@@") && !line.startsWith("index "))
    .join("\n");
}

function readPr(pr, root) {
  const view = ghJson(
    [
      "pr",
      "view",
      String(pr),
      "--json",
      "state,isDraft,headRefOid,headRefName,baseRefName,mergeCommit",
    ],
    root,
  );

  const state = stringField(view, "state");
  const head = stringField(view, "headRefOid");
  const branch = stringField(view, "headRefName");
  const base = stringField(view, "baseRefName");

  if (state === null || head === null || branch === null || base === null) {
    die(`gh pr view ${pr} did not return a pull request`);
  }

  return {
    state,
    draft: readField(view, "isDraft") === true,
    head,
    branch,
    base,
    mergeCommit: stringField(readField(view, "mergeCommit"), "oid"),
  };
}

function commandMerge(slug, id, argv) {
  const { wait } = parseMergeFlags(argv);
  const { root, statePath } = campaignPaths(slug);

  if (!id) die("merge needs an item id");
  const { items } = readState(statePath, root);
  const item = items.find((candidate) => stringField(candidate, "id") === id);

  if (item === undefined) die(`no item ${id} in ${statePath}`);
  const phase = stringField(item, "phase");

  if (phase !== "landed")
    die(`item ${id} is ${phase}, not landed: the land phase has not finished`);
  const pr = Number(readField(item, "pr"));

  if (!Number.isInteger(pr) || pr <= 0) die(`item ${id} has no PR number`);

  // Gate 1: open and out of draft.
  const before = readPr(pr, root);

  if (before.state !== "OPEN") die(`PR #${pr} is ${before.state}, not OPEN`);

  if (before.draft) die(`PR #${pr} is a draft`);

  // Gate 2: one head everywhere, and nothing uncommitted behind it.
  run("git", ["fetch", "-q", "origin", before.branch, before.base], root);
  const remoteTip = run("git", ["rev-parse", `origin/${before.branch}`], root);

  if (remoteTip !== before.head) {
    die(
      `PR #${pr} head ${before.head.slice(0, 9)} is not origin/${before.branch} ${remoteTip.slice(0, 9)}`,
    );
  }

  const worktree = stringField(item, "worktree");

  const worktreePath =
    worktree === null ? null : worktree.startsWith("/") ? worktree : join(root, worktree);

  const hasWorktree = worktreePath !== null && existsSync(worktreePath);

  if (hasWorktree) {
    const local = run("git", ["-C", worktreePath, "rev-parse", "HEAD"], root);

    if (local !== before.head) {
      die(
        `worktree ${worktreePath} HEAD ${local.slice(0, 9)} is not the PR head ${before.head.slice(0, 9)}: push or reset it first`,
      );
    }

    const dirty = run("git", ["-C", worktreePath, "status", "--porcelain"], root);

    if (dirty !== "") die(`worktree ${worktreePath} has uncommitted changes:\n${dirty}`);
  }

  // Gate 3: CI green, by the one wait loop the repo trusts.
  process.stdout.write(`PR #${pr}: waiting up to ${wait} min for CI\n`);

  const ci = spawnSync(
    process.execPath,
    [WAIT_SCRIPT, String(pr), "--interval", "15", "--timeout", String(wait)],
    { cwd: root, stdio: "inherit" },
  );

  if (ci.status !== 0)
    die(
      `CI for PR #${pr} is not green (wait-pr-checks exit ${ci.status}). Fix the red check, then merge.`,
    );

  // Gate 4: squash exactly the head that passed. A push after the wait fails the merge.
  const priorBase = run("git", ["rev-parse", `origin/${before.base}`], root);
  run("gh", ["pr", "merge", String(pr), "--squash", "--match-head-commit", before.head], root);
  const after = readPr(pr, root);

  if (after.state !== "MERGED" || after.mergeCommit === null) {
    die(`PR #${pr} is ${after.state} after gh pr merge, with no merge commit`);
  }

  const squash = after.mergeCommit;
  run("git", ["fetch", "-q", "origin", before.base], root);

  // Gate 5: the squash holds the branch, and nothing else.
  const parent = run("git", ["rev-parse", `${squash}^`], root);
  const forkPoint = run("git", ["merge-base", before.head, parent], root);
  const branchPatch = run("git", ["diff", "--no-color", forkPoint, before.head], root);
  const squashPatch = run("git", ["diff", "--no-color", parent, squash], root);
  let verdict = "PATCH-SAME";

  if (branchPatch !== squashPatch) {
    verdict =
      changedLines(root, forkPoint, before.head) === changedLines(root, parent, squash)
        ? "PATCH-SAME-LINES"
        : "PATCH-DIFF";
  }

  const stamp = `${new Date().toISOString().slice(0, 16)}Z`;
  const short = squash.slice(0, 9);
  const baseNote = parent === priorBase ? "" : `; ${before.base} moved during the merge`;

  if (verdict === "PATCH-DIFF") {
    stateWrite(root, [
      "note",
      "--state",
      statePath,
      `- [orchestrator ${stamp}] #${pr} (${id}) MERGED ${short}, PATCH-DIFF: compare \`git diff ${forkPoint.slice(0, 9)} ${before.head.slice(0, 9)}\` with \`git show ${short}\`; worktree kept${baseNote}.`,
    ]);
    die(
      `PR #${pr} merged as ${short}, but its patch differs from the branch patch. The worktree stays. Compare the two diffs by hand.`,
    );
  }

  // Gate 6: clean up and record.
  if (hasWorktree) run("git", ["worktree", "remove", worktreePath], root);
  stateWrite(root, [
    "set",
    "--state",
    statePath,
    "--id",
    id,
    "worktree=null",
    `note=PR #${pr} merged ${short}`,
  ]);
  stateWrite(root, [
    "note",
    "--state",
    statePath,
    `- [orchestrator ${stamp}] #${pr} (${id}) MERGED ${short}, ${verdict}; head ${before.head.slice(0, 9)} matched origin${hasWorktree ? "; worktree removed" : ""}${baseNote}.`,
  ]);
  process.stdout.write(`PR #${pr} (${id}) merged as ${short}, ${verdict}.\n`);
}

// --- entry ----------------------------------------------------------------

// `status | head` closes the pipe early. That is not a failure of the command.
process.stdout.on("error", (error) => {
  if (Reflect.get(error, "code") === "EPIPE") process.exit(0);

  throw error;
});

const cliArgs = process.argv.slice(2);

if (cliArgs.includes("--admin")) die(ADMIN_REFUSAL);

// `.at(0)` keeps the `undefined` an empty argv yields; scripts/ runs without noUncheckedIndexedAccess.
const command = cliArgs.at(0);

switch (command) {
  case "status":
    commandStatus(cliArgs.at(1));
    break;
  case "merge":
    commandMerge(cliArgs.at(1), cliArgs.at(2), cliArgs.slice(3));
    break;
  case undefined:
  default:
    die(
      `unknown command ${command ?? "(none)"}. Expected: status <slug> | merge <slug> <id> [--wait <minutes>]`,
    );
}
