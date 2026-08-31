// Stops every Alfred dev process this machine is still running, including the
// ones you cannot see.
//
// Why this exists rather than "just Ctrl-C it". `pnpm dev` runs the server under
// a `tsx watch` supervisor. That supervisor binds no port, so it is invisible to
// every way a person normally checks — `lsof -i :3001` finds only the child it
// spawned, and killing that child makes the supervisor spawn a fresh one within
// seconds. If the launching terminal goes away without delivering a signal, the
// whole tree is reparented to launchd with no controlling TTY, at which point no
// Ctrl-C can ever reach it again. One such orphan ran for three days, respawning
// its child on every file change and billing real tokens the entire time.
//
// So this matches on the COMMAND LINE, never on a port, and it kills supervisors
// before their children so nothing gets a chance to respawn.
//
// Usage: pnpm dev:stop [--dry-run]

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Command-line fragments that identify a dev process **anchored to this
 * checkout** — each is matched together with {@link ROOT}, so a second clone of
 * this repo, or an unrelated project's `turbo run dev`, is never touched.
 *
 * This list is a seed, not the whole answer. It cannot be, because the two pnpm
 * processes above `tsx watch` carry neither the repo path nor a recognizable
 * script name (`node /opt/homebrew/bin/pnpm --filter server dev`). The tree walk
 * below is what actually finds those; anything this list misses entirely is
 * reported under "not matched" rather than silently skipped.
 */
const DEV_COMMAND_PATTERNS = [
  // `tsx watch` never appears literally — the real command line is
  // `node .../tsx/dist/cli.mjs watch --env-file=.env src/index.ts`, so match the
  // binary and the subcommand separately. Getting this wrong is not theoretical:
  // the literal string missed the exact orphan this script was written for.
  /\btsx\b[^\n]*\bwatch\b/,
  /\bturbo\b[^\n]*\brun dev\b/,
  /\bnext\b[^\n]*\bdev\b/,
  /\bvite\b/,
];

/** Commands allowed to be pulled in as an ANCESTOR of a matched dev process. */
const SUPERVISOR_PATTERNS = ["pnpm", "turbo", "npm exec", "node "];

function listProcesses() {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,tty=,command="], { encoding: "utf8" });
  const byPid = new Map();
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const proc = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      command: match[4].trim(),
    };
    byPid.set(proc.pid, proc);
  }
  return byPid;
}

/** Our own pid and every ancestor, which must never be killed. */
function selfLineage(byPid) {
  const mine = new Set([process.pid]);
  let pid = process.ppid;
  for (let hops = 0; hops < 16 && pid > 1; hops += 1) {
    mine.add(pid);
    const parent = byPid.get(pid);
    if (!parent) break;
    pid = parent.ppid;
  }
  return mine;
}

const byPid = listProcesses();
const mine = selfLineage(byPid);
const all = [...byPid.values()];

const seeds = all.filter(
  (proc) =>
    !mine.has(proc.pid) &&
    !proc.command.includes("dev-stop") &&
    proc.command.includes(ROOT) &&
    DEV_COMMAND_PATTERNS.some((pattern) => pattern.test(proc.command)),
);

const targets = new Map();
for (const seed of seeds) targets.set(seed.pid, seed);

// Walk UP from each seed. The supervisor chain (`pnpm --filter server dev` →
// pnpm's internal shim → `tsx watch`) is the part that survives the terminal,
// and only the bottom link names the repo — so the ancestors have to be reached
// through the tree, not through a text match. Stop at the first ancestor that is
// not a plausible supervisor, so the walk never climbs into the user's shell.
for (const seed of seeds) {
  let parent = byPid.get(seed.ppid);
  for (let hops = 0; hops < 8 && parent && parent.pid > 1; hops += 1) {
    if (mine.has(parent.pid)) break;
    if (!SUPERVISOR_PATTERNS.some((pattern) => parent.command.includes(pattern))) break;
    targets.set(parent.pid, parent);
    parent = byPid.get(parent.ppid);
  }
}

// Walk DOWN, so a server the supervisor already spawned dies with it.
const childrenOf = new Map();
for (const proc of all) {
  const siblings = childrenOf.get(proc.ppid) ?? [];
  siblings.push(proc);
  childrenOf.set(proc.ppid, siblings);
}
const queue = [...targets.keys()];
while (queue.length > 0) {
  const pid = queue.pop();
  for (const child of childrenOf.get(pid) ?? []) {
    if (mine.has(child.pid) || targets.has(child.pid)) continue;
    targets.set(child.pid, child);
    queue.push(child.pid);
  }
}

// Anything in this checkout we deliberately did NOT match. Printed so a dev
// process whose command shape nobody anticipated is visible rather than silently
// left running — the failure mode this whole script exists to fix.
const unmatched = all.filter(
  (proc) =>
    !targets.has(proc.pid) &&
    !mine.has(proc.pid) &&
    proc.command.includes(ROOT) &&
    !proc.command.includes("dev-stop"),
);

function describe(proc) {
  const orphan = proc.ppid === 1 ? " [ORPHANED]" : "";
  const detached = proc.tty === "??" ? " [NO TTY]" : "";
  return `  pid ${proc.pid} (ppid ${proc.ppid})${orphan}${detached}\n    ${proc.command.slice(0, 132)}`;
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // Already gone, or not ours to signal. Both are fine.
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (unmatched.length > 0) {
  console.log(`Other processes under ${ROOT} (left alone):`);
  for (const proc of unmatched) console.log(describe(proc));
  console.log("");
}

const found = [...targets.values()];
if (found.length === 0) {
  console.log("No Alfred dev processes are running.");
  process.exit(0);
}

console.log(`Found ${found.length} Alfred dev process(es):`);
for (const proc of found) console.log(describe(proc));

if (DRY_RUN) {
  console.log("\n--dry-run: nothing was killed.");
  process.exit(0);
}

// Supervisors first: killing a parent before its child denies the parent the
// chance to respawn what we are about to remove.
const ordered = found.sort((a, b) => {
  const aSupervised = targets.has(a.ppid) ? 1 : 0;
  const bSupervised = targets.has(b.ppid) ? 1 : 0;
  return aSupervised - bSupervised;
});

console.log("\nSending SIGTERM...");
for (const proc of ordered) signal(proc.pid, "SIGTERM");

// Give them a moment to unwind — BullMQ workers close their queues on shutdown.
const deadline = Date.now() + 3000;
while (Date.now() < deadline && ordered.some((p) => alive(p.pid))) {
  execFileSync("sleep", ["0.2"]);
}

const stubborn = ordered.filter((p) => alive(p.pid));
if (stubborn.length > 0) {
  console.log(`SIGKILL for ${stubborn.length} that ignored SIGTERM...`);
  for (const proc of stubborn) signal(proc.pid, "SIGKILL");
  execFileSync("sleep", ["0.5"]);
}

const survivors = ordered.filter((p) => alive(p.pid));
if (survivors.length > 0) {
  console.error("Could not stop:");
  for (const proc of survivors) console.error(describe(proc));
  process.exit(1);
}

console.log(`Stopped ${found.length} process(es). Nothing is left to respawn them.`);
