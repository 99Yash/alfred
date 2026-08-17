// Run a task against a real coding agent (`opencode run`) in a hermetic
// worktree. The agent works at the task's base commit with only the prompt: a
// disposable clone fetches that one commit at depth 1, so no other commit — and
// no answer — is reachable. Its final working-tree diff is the submission; all
// artifacts land in `references/bench/<taskId>/<timestamp>/`.
//
// Usage:
//   node scripts/bench/run.mjs <taskId> [--model <model>] [--timeout-min <n>]
//     [--install] [--dry-run]

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readManifest, repoRoot, runsRoot } from "./manifest.mjs";

const USAGE = `node scripts/bench/run.mjs <taskId> [--model <model>] [--timeout-min <n>] [--install] [--dry-run]`;

const DEFAULT_TIMEOUT_MIN = 30;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * @typedef {object} RunArgs
 * @property {string} taskId
 * @property {string | null} model
 * @property {number} timeoutMin
 * @property {boolean} install
 * @property {boolean} dryRun
 */

/** @param {string[]} argv @returns {RunArgs} */
export function parseArgs(argv) {
  /** @type {RunArgs} */
  const args = {
    taskId: "",
    model: null,
    timeoutMin: DEFAULT_TIMEOUT_MIN,
    install: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--model":
        args.model = argv[++i] ?? null;
        break;
      case "--timeout-min":
        args.timeoutMin = Number(argv[++i]);
        break;
      case "--install":
        args.install = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        if (args.taskId === "") {
          args.taskId = flag;
        } else {
          throw new Error(`unknown flag ${flag}\n${USAGE}`);
        }
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(args.taskId))
    throw new Error(`bad taskId ${JSON.stringify(args.taskId)}\n${USAGE}`);
  if (!Number.isFinite(args.timeoutMin) || args.timeoutMin <= 0)
    throw new Error(`bad --timeout-min ${args.timeoutMin}`);
  return args;
}

/** A local, path-safe timestamp: `20260816-120000`. @returns {string} */
export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Run a command and wait for it, capturing its stdout+stderr into `capture`.
 * Kills the whole process group on timeout.
 *
 * @param {string} cwd
 * @param {string[]} argv
 * @param {{ capture?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number | null, timedOut: boolean }>}
 */
export function runCommand(cwd, argv, options = {}) {
  return new Promise((resolve) => {
    const sink = options.capture ? createWriteStream(options.capture) : null;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", sink ? "pipe" : "inherit", sink ? "pipe" : "inherit"],
    });
    if (sink && child.stdout) child.stdout.pipe(sink);
    if (sink && child.stderr) child.stderr.pipe(sink);
    let timedOut = false;
    const pid = child.pid;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            if (pid !== undefined) {
              try {
                process.kill(-pid, "SIGKILL");
              } catch {
                // The process group is already gone.
              }
            }
          }, options.timeoutMs);
    child.on("error", (error) => {
      if (timer !== null) clearTimeout(timer);
      if (sink) sink.end();
      console.error(`spawn failed: ${error.message}`);
      resolve({ code: -1, timedOut });
    });
    child.on("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      if (sink) sink.end();
      resolve({ code, timedOut });
    });
  });
}

/**
 * @param {RunArgs} args
 * @returns {Promise<string | null>} The run directory, or null in dry-run.
 */
export async function runTask(args) {
  const root = repoRoot();
  const { manifest } = readManifest(root, args.taskId);

  const runsDir = join(runsRoot(root), manifest.id, timestamp());
  mkdirSync(runsDir, { recursive: true });
  const worktree = join(runsDir, "worktree");
  const trajectory = join(runsDir, "trajectory.jsonl");

  const originUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const clone = join(runsDir, "clone");
  const initArgv = ["git", "init", "--quiet", clone];
  const remoteArgv = ["git", "-C", clone, "remote", "add", "origin", originUrl];
  // Depth 1 on purpose: the agent must not see any commit past the base. A
  // task mined from this repo's history is answerable from that history (the
  // a-834 run proved it: the agent `git show`-ed the real solution commit and
  // applied it). One commit and its tree are all the agent may ever see.
  const fetchArgv = [
    "git",
    "-C",
    clone,
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "origin",
    manifest.base,
  ];
  const addArgv = ["git", "-C", clone, "worktree", "add", "--detach", worktree, manifest.base];
  const agentArgv = ["opencode", "run", "--format", "json", "--dir", worktree, "--auto"];
  if (args.model !== null) agentArgv.push("--model", args.model);
  agentArgv.push(
    "Complete the task described in TASK.md at the repository root. The definition of done lists the commands that must pass. Do not commit.",
  );
  const installArgv = ["corepack", "pnpm", "install", "--frozen-lockfile"];
  const diffArgv = ["diff", "--cached", "HEAD"];

  if (args.dryRun) {
    console.log(`run dir    ${runsDir}`);
    console.log(`worktree   ${worktree}`);
    console.log(`$ ${initArgv.join(" ")}`);
    console.log(`$ ${remoteArgv.join(" ")}`);
    console.log(`$ ${fetchArgv.join(" ")}`);
    console.log(`$ ${addArgv.join(" ")}`);
    console.log(`TASK.md <- ${manifest.promptFile}`);
    if (args.install) console.log(`$ ${installArgv.join(" ")}`);
    console.log(`$ ${agentArgv.join(" ")}  (timeout ${args.timeoutMin} min, -> ${trajectory})`);
    console.log(`$ git add -A && git ${diffArgv.join(" ")}  -> agent.patch`);
    console.log(`$ git worktree remove --force ${worktree}`);
    console.log(`$ rm -rf ${clone}`);
    return null;
  }

  const startedAt = new Date().toISOString();
  await runCommand(root, ["git", "fetch", "origin", manifest.base], { timeoutMs: 5 * 60 * 1000 });
  mkdirSync(clone, { recursive: true });
  const initResult = await runCommand(root, initArgv);
  if (initResult.code !== 0)
    throw new Error(`git init failed (${initResult.code}): ${initArgv.join(" ")}`);
  const remoteResult = await runCommand(root, remoteArgv);
  if (remoteResult.code !== 0)
    throw new Error(`git remote add failed (${remoteResult.code}): ${remoteArgv.join(" ")}`);
  const fetchResult = await runCommand(root, fetchArgv, { timeoutMs: 10 * 60 * 1000 });
  if (fetchResult.code !== 0)
    throw new Error(`depth-1 fetch failed (${fetchResult.code}): ${fetchArgv.join(" ")}`);
  const addResult = await runCommand(root, addArgv);
  if (addResult.code !== 0) {
    throw new Error(`git worktree add failed (${addResult.code}): ${addArgv.join(" ")}`);
  }

  const prompt = readFileSync(join(root, manifest.promptFile), "utf8");
  writeFileSync(join(worktree, "TASK.md"), prompt);

  if (args.install) {
    const installResult = await runCommand(worktree, installArgv, {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (installResult.code !== 0) {
      console.error(`install failed (${installResult.code}); continuing without node_modules`);
    }
  }

  const agentResult = await runCommand(root, agentArgv, {
    capture: trajectory,
    timeoutMs: args.timeoutMin * 60 * 1000,
  });

  await runCommand(worktree, ["git", "add", "-A"]);
  await runCommand(worktree, ["git", "restore", "--staged", "TASK.md"]);
  const agentDiff = execFileSync("git", diffArgv, { cwd: worktree, encoding: "utf8" });
  writeFileSync(join(runsDir, "agent.patch"), agentDiff);

  writeFileSync(
    join(runsDir, "meta.json"),
    `${JSON.stringify(
      {
        taskId: manifest.id,
        model: args.model,
        base: manifest.base,
        startedAt,
        finishedAt: new Date().toISOString(),
        agentExitCode: agentResult.code,
        timedOut: agentResult.timedOut,
        install: args.install,
        patchBytes: Buffer.byteLength(agentDiff),
      },
      null,
      2,
    )}\n`,
  );

  await runCommand(clone, ["git", "worktree", "remove", "--force", worktree]);
  await runCommand(root, ["rm", "-rf", clone]);
  return runsDir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const runsDir = await runTask(args);
    if (runsDir !== null) console.log(`run complete -> ${runsDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  await main();
}
