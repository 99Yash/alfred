// Mine a merged PR into a benchmark task. Reads the PR from GitHub with `gh`,
// splits its diff into a hidden test patch and a gold patch, and writes a task
// directory under `scripts/bench/tasks/`.
//
// The prompt deliberately strips the `## What this change does` section: that
// section is the answer to the task. What remains is the problem, the measured
// behavior, and the definition of done.
//
// Usage:
//   node scripts/bench/mine-task.mjs --id a-834 --pr 834 \
//     --verify "node scripts/campaign-state.selftest.mjs"

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isTestFile, patchPaths, repoRoot, tasksRoot, validateManifest } from "./manifest.mjs";

const USAGE = `node scripts/bench/mine-task.mjs --id <id> --pr <n> --verify "<cmd>"
  --id <id>         Task id, a-834-style.
  --pr <n>          The merged GitHub PR number.
  --verify "<cmd>"  Shell command that proves the task done, run in the worktree.
                    Repeat the flag for several commands.
  --issue <n>       Optional. An issue the PR closes, named in the prompt.`;

/**
 * @typedef {object} MineArgs
 * @property {string} id
 * @property {number} pr
 * @property {string[]} verify
 * @property {number | null} issue
 */

/** @param {string[]} argv @returns {MineArgs} */
export function parseArgs(argv) {
  /** @type {MineArgs} */
  const args = { id: "", pr: 0, verify: [], issue: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--id":
        args.id = argv[++i] ?? "";
        break;
      case "--pr":
        args.pr = Number(argv[++i]);
        break;
      case "--verify":
        args.verify.push(argv[++i] ?? "");
        break;
      case "--issue":
        args.issue = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown flag ${flag}\n${USAGE}`);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(args.id)) {
    throw new Error(`--id must be a lowercase slug like "a-834", got ${JSON.stringify(args.id)}`);
  }
  if (!Number.isInteger(args.pr) || args.pr <= 0) {
    throw new Error(`--pr must be a positive integer, got ${args.pr}`);
  }
  if (args.verify.length === 0 || args.verify.some((command) => command.trim() === "")) {
    throw new Error("--verify is required");
  }
  if (args.issue !== null && (!Number.isInteger(args.issue) || args.issue <= 0)) {
    throw new Error(`--issue must be a positive integer, got ${args.issue}`);
  }
  return args;
}

/**
 * Remove `## What this change does` and everything after it from a PR body.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripSolution(body) {
  return body.replace(/^## what this change does[\s\S]*$/im, "").trim();
}

/**
 * Split a PR diff into its hidden test patch and its gold patch.
 *
 * @param {string} patch
 * @returns {{ test: string, gold: string }}
 */
export function splitPatch(patch) {
  const test = [];
  const gold = [];
  for (const chunk of patch.split(/(?=^diff --git )/m)) {
    const path = /^diff --git a\/(\S+)/m.exec(chunk)?.[1];
    if (path === undefined) continue;
    (isTestFile(path) ? test : gold).push(chunk);
  }
  return { test: test.join(""), gold: gold.join("") };
}

/**
 * Build the prompt for a mined task. The title and the surviving body sections
 * are the whole task statement; the definition of done names the verify command.
 *
 * The prompt is anonymized on purpose. The a-834 run proved that a prompt that
 * says "PR #834" hands the agent its own answer: the agent ran `gh pr diff 834`
 * and replayed the real diff. A task must read as a standalone bug report, with
 * the checkout as the only context.
 *
 * @param {{ title: string, body: string }} pr
 * @param {MineArgs} args
 * @returns {string}
 */
export function buildPrompt(pr, args) {
  const clean = stripSolution(pr.body);
  return [
    `# ${pr.title}`,
    "",
    "This is the Alfred repository at the commit the task starts from. The change below has not been made yet.",
    "",
    clean,
    "",
    "## Ground rules",
    "- The repository checkout is the entire context. Do not use the network, and do not look this task up on GitHub or anywhere else.",
    "- Do not edit test files or self-tests. The grading harness owns them.",
    "",
    "## Definition of done",
    ...args.verify.map((command) => `- [ ] \`${command}\` passes`),
    "",
  ].join("\n");
}

/**
 * Mine one PR into a task directory. Returns the written manifest.
 *
 * @param {MineArgs} args
 * @returns {import("./manifest.mjs").TaskManifest}
 */
export function mineTask(args) {
  const root = repoRoot();
  const metaText = execFileSync(
    "gh",
    ["pr", "view", String(args.pr), "--json", "title,body,baseRefOid,mergedAt"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const meta = JSON.parse(metaText);
  const title = /** @type {string} */ (meta.title);
  const body = /** @type {string} */ (meta.body);
  const base = /** @type {string} */ (meta.baseRefOid);
  const mergedAt = /** @type {string} */ (meta.mergedAt);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`PR #${args.pr} has no 40-hex baseRefOid`);

  const diff = execFileSync("gh", ["pr", "diff", String(args.pr)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const { test, gold } = splitPatch(diff);
  if (test.trim() === "")
    throw new Error(`PR #${args.pr} carries no test-file changes; pick another PR`);
  if (gold.trim() === "")
    throw new Error(`PR #${args.pr} carries no implementation changes; pick another PR`);

  const dir = join(tasksRoot(root), args.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.md"), buildPrompt({ title, body }, args));
  writeFileSync(join(dir, "test.patch"), test);
  writeFileSync(join(dir, "gold.patch"), gold);

  const manifest = /** @type {import("./manifest.mjs").TaskManifest} */ ({
    id: args.id,
    tier: "a",
    title,
    base,
    source: { kind: "pr", pr: args.pr, mergedAt },
    promptFile: `scripts/bench/tasks/${args.id}/prompt.md`,
    testPatch: `scripts/bench/tasks/${args.id}/test.patch`,
    goldPatch: `scripts/bench/tasks/${args.id}/gold.patch`,
    hiddenFiles: patchPaths(test),
    verify: args.verify,
    createdAt: new Date().toISOString(),
  });

  const failures = validateManifest(manifest, root);
  if (failures.length > 0) {
    throw new Error(`mined task ${args.id} fails validation:\n- ${failures.join("\n- ")}`);
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = mineTask(args);
  console.log(`task ${args.id} written under scripts/bench/tasks/${args.id}/`);
  console.log(`base ${manifest.base}`);
  console.log(`hidden test files:\n- ${manifest.hiddenFiles.join("\n- ")}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
