// Grade a task run. Replays the submission in a fresh worktree at the task's
// base commit, applies the hidden tests, and checks (a) that every verify
// command passes and (b) that the submission did not touch the hidden test
// files. Three modes:
//
//   - default        Grade a run: `--patch <file>` or the newest run's patch.
//   - `--gold`       Grade the reference solution. Must pass.
//   - `--check-discriminator`  Apply only the hidden tests to the clean base.
//                    They must FAIL, or the task does not test what it claims.
//
// Usage:
//   node scripts/bench/grade.mjs <taskId> [--patch <file> | --gold | --check-discriminator]
//     [--install | --no-install] [--timeout-s <n>]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readManifest, repoRoot, runsRoot } from "./manifest.mjs";
import { gradeProcessLane } from "./process-lane.mjs";
import { runCommand, timestamp } from "./run.mjs";

const USAGE = `node scripts/bench/grade.mjs <taskId> [--patch <file> | --gold | --check-discriminator] [--install | --no-install] [--timeout-s <n>]`;

const DEFAULT_TIMEOUT_S = 600;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * @typedef {"run" | "gold" | "discriminator"} GradeMode
 *
 * @typedef {object} GradeArgs
 * @property {string} taskId
 * @property {GradeMode} mode
 * @property {string | null} patch
 * @property {boolean | null} install null means decide from the verify commands.
 * @property {number} timeoutS
 *
 * @typedef {object} StepResult
 * @property {boolean} ok
 * @property {string} detail
 *
 * @typedef {object} GradeReport
 * @property {string} taskId
 * @property {GradeMode} mode
 * @property {string} base
 * @property {string | null} submission
 * @property {StepResult} apply
 * @property {boolean} testPatchApplied
 * @property {Array<{ command: string, exitCode: number | null, ok: boolean, timedOut: boolean, log: string }>} verify
 * @property {Array<{ file: string, ok: boolean, detail: string }>} conduct
 * @property {{ ok: boolean, touched: string[], expected: string[] } | null} targetFiles
 * @property {Array<{ rule: string, ok: boolean, detail: string, evidence?: string[] }> | null} processLane
 * @property {string} verdict
 */

/** @param {string[]} argv @returns {GradeArgs} */
export function parseArgs(argv) {
  /** @type {GradeArgs} */
  const args = { taskId: "", mode: "run", patch: null, install: null, timeoutS: DEFAULT_TIMEOUT_S };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--patch":
        args.patch = argv[++i] ?? null;
        break;
      case "--gold":
        args.mode = "gold";
        break;
      case "--check-discriminator":
        args.mode = "discriminator";
        break;
      case "--install":
        args.install = true;
        break;
      case "--no-install":
        args.install = false;
        break;
      case "--timeout-s":
        args.timeoutS = Number(argv[++i]);
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
  if (!Number.isFinite(args.timeoutS) || args.timeoutS <= 0)
    throw new Error(`bad --timeout-s ${args.timeoutS}`);
  return args;
}

/** @param {string} path @returns {string} An absolute path, whatever was given. */
function absolute(root, path) {
  return path.startsWith("/") ? path : join(root, path);
}

/** The newest run's agent patch under `references/bench/<id>/`, or null. @param {string} root @param {string} id @returns {string | null} */
function newestAgentPatch(root, id) {
  const base = join(runsRoot(root), id);
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const patches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(base, entry.name, "agent.patch");
    try {
      const stat = statSync(file);
      patches.push({ file, mtime: stat.mtimeMs });
    } catch {
      // This run directory has no patch.
    }
  }
  if (patches.length === 0) return null;
  patches.sort((a, b) => b.mtime - a.mtime);
  return patches[0]?.file ?? null;
}

/**
 * Run `git apply` against a patch, falling back to 3-way mode.
 *
 * @param {string} worktree @param {string} patch @returns {Promise<StepResult>}
 */
async function applyPatch(worktree, patch) {
  const plain = await runCommand(worktree, ["git", "apply", "--whitespace=nowarn", patch]);
  if (plain.code === 0) return { ok: true, detail: "applied cleanly" };
  const threeWay = await runCommand(worktree, [
    "git",
    "apply",
    "--3way",
    "--whitespace=nowarn",
    patch,
  ]);
  if (threeWay.code === 0) return { ok: true, detail: "applied via 3-way merge" };
  return { ok: false, detail: `git apply failed (${plain.code}), 3-way failed (${threeWay.code})` };
}

/**
 * @param {string} worktree
 * @param {string} base
 * @param {string[]} files
 * @returns {Promise<string[]>} The files whose working-tree state differs from base.
 */
async function changedSince(worktree, base, files) {
  const changed = [];
  for (const file of files) {
    const result = await runCommand(worktree, ["git", "diff", "--quiet", base, "--", file]);
    if (result.code !== 0) changed.push(file);
  }
  return changed;
}

/**
 * @param {string} worktree @param {string} base @param {string[]} files @returns {Promise<void>}
 */
async function restoreToBase(worktree, base, files) {
  if (files.length === 0) return;
  await runCommand(worktree, [
    "git",
    "restore",
    "--source",
    base,
    "--worktree",
    "--staged",
    "--",
    ...files,
  ]);
}

/**
 * Grade one task. Writes `report.json` beside the throwaway worktree.
 *
 * @param {GradeArgs} args
 * @returns {Promise<GradeReport>}
 */
export async function gradeTask(args) {
  const root = repoRoot();
  const { manifest } = readManifest(root, args.taskId);

  let submission = /** @type {string | null} */ (null);
  if (args.mode === "gold") {
    submission = join(root, manifest.goldPatch ?? "");
  } else if (args.mode === "run") {
    const patch = args.patch ?? newestAgentPatch(root, manifest.id);
    if (patch === null) {
      throw new Error(
        `no run patch found under ${join(runsRoot(root), manifest.id)}; pass --patch <file>`,
      );
    }
    submission = absolute(root, patch);
  }

  const gradeDir = join(runsRoot(root), manifest.id, `grade-${args.mode}-${timestamp()}`);
  const worktree = join(gradeDir, "worktree");
  mkdirSync(gradeDir, { recursive: true });

  await runCommand(root, ["git", "fetch", "origin", manifest.base], { timeoutMs: 5 * 60 * 1000 });
  const addResult = await runCommand(root, [
    "git",
    "worktree",
    "add",
    "--detach",
    worktree,
    manifest.base,
  ]);
  if (addResult.code !== 0) {
    throw new Error(`git worktree add failed (${addResult.code})`);
  }

  const needsInstall =
    args.install ?? manifest.verify.some((command) => command.startsWith("pnpm"));
  if (needsInstall) {
    const installResult = await runCommand(
      worktree,
      ["corepack", "pnpm", "install", "--frozen-lockfile"],
      {
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    if (installResult.code !== 0) {
      console.error(`install failed (${installResult.code}); verify commands will likely fail`);
    }
  }

  /** @type {GradeReport} */
  const report = {
    taskId: manifest.id,
    mode: args.mode,
    base: manifest.base,
    submission: null,
    apply: { ok: true, detail: "no submission patch" },
    testPatchApplied: false,
    verify: [],
    conduct: [],
    targetFiles: null,
    processLane: null,
    verdict: "broken",
  };

  if (submission !== null) {
    report.submission = submission.replace(root, ".");
    report.apply = await applyPatch(worktree, submission);
    if (!report.apply.ok) {
      await runCommand(root, ["git", "worktree", "remove", "--force", worktree]);
      writeFileSync(join(gradeDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      return report;
    }
    const touched = await changedSince(worktree, manifest.base, manifest.hiddenFiles);
    // Also check if hidden files exist on disk but not at the base (the agent
    // created them as untracked files, which git diff doesn't detect).
    for (const file of manifest.hiddenFiles) {
      const check = await runCommand(worktree, [
        "git",
        "cat-file",
        "-e",
        `${manifest.base}:${file}`,
      ]);
      const existsOnDisk = existsSync(join(worktree, file));
      if (check.code !== 0 && existsOnDisk && !touched.includes(file)) {
        touched.push(file);
      }
    }
    for (const file of manifest.hiddenFiles) {
      report.conduct.push({
        file,
        ok: !touched.includes(file),
        detail: touched.includes(file) ? "submission edits a hidden test file" : "untouched",
      });
    }
    // Remove hidden files that don't exist at the base (the agent shouldn't have
    // created them; the test patch will provide them if needed).
    for (const file of manifest.hiddenFiles) {
      const check = await runCommand(worktree, [
        "git",
        "cat-file",
        "-e",
        `${manifest.base}:${file}`,
      ]);
      if (check.code !== 0) {
        await runCommand(worktree, ["rm", "-f", file]);
      }
    }
    await restoreToBase(worktree, manifest.base, manifest.hiddenFiles);
  }

  if (manifest.testPatch !== null) {
    const applied = await applyPatch(worktree, join(root, manifest.testPatch));
    report.testPatchApplied = applied.ok;
    if (!applied.ok) {
      await runCommand(root, ["git", "worktree", "remove", "--force", worktree]);
      report.apply = { ok: false, detail: applied.detail };
      writeFileSync(join(gradeDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      return report;
    }
  }

  for (let i = 0; i < manifest.verify.length; i += 1) {
    const command = manifest.verify[i] ?? "";
    const log = join(gradeDir, `verify-${i}.log`);
    const result = await runCommand(worktree, ["/bin/sh", "-c", command], {
      capture: log,
      timeoutMs: args.timeoutS * 1000,
    });
    let detail = "";
    try {
      detail = readFileSync(log, "utf8").trim().slice(0, 500);
    } catch {
      // No log captured.
    }
    report.verify.push({
      command,
      exitCode: result.code,
      ok: result.code === 0,
      timedOut: result.timedOut,
      log: detail,
    });
  }

  await runCommand(root, ["git", "worktree", "remove", "--force", worktree]);

  const verifyPass = report.verify.every((entry) => entry.ok);
  const conductPass = report.conduct.every((entry) => entry.ok);

  // Tier c discriminator: the agent's patch must modify at least one target file.
  let targetFilesPass = true;
  if (submission !== null && manifest.tier === "c" && manifest.targetFiles?.length > 0) {
    const patchContent = readFileSync(submission, "utf8");
    const touched = patchPaths(patchContent);
    targetFilesPass = manifest.targetFiles.some((f) => touched.includes(f));
    report.targetFiles = { ok: targetFilesPass, touched, expected: manifest.targetFiles };
  }

  // Process lane: grade the agent's trajectory when available.
  if (submission !== null) {
    const runDir = submission.includes("/agent.patch")
      ? submission.replace(/\/agent\.patch$/, "")
      : null;
    const trajectoryPath = runDir ? join(runDir, "trajectory.jsonl") : null;
    if (trajectoryPath !== null && existsSync(trajectoryPath)) {
      report.processLane = await gradeProcessLane(trajectoryPath, manifest);
    }
  }

  const processPass = report.processLane === null || report.processLane.every((entry) => entry.ok);

  if (args.mode === "discriminator") {
    report.verdict = verifyPass ? "discriminator-fails" : "discriminator-holds";
  } else {
    report.verdict = verifyPass && conductPass && targetFilesPass && processPass ? "pass" : "fail";
  }

  writeFileSync(join(gradeDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await gradeTask(args);
    console.log(`${report.verdict} (mode ${args.mode})`);
    for (const entry of report.verify) {
      console.log(
        `  [${entry.ok ? "ok" : "FAIL"}] ${entry.command}${entry.timedOut ? " (timed out)" : ""}`,
      );
    }
    for (const entry of report.conduct) {
      console.log(`  [${entry.ok ? "ok" : "FAIL"}] hidden: ${entry.file} — ${entry.detail}`);
    }
    if (report.processLane !== null) {
      for (const entry of report.processLane) {
        console.log(`  [${entry.ok ? "ok" : "FAIL"}] process: ${entry.rule} — ${entry.detail}`);
      }
    }
    if (report.verdict === "pass" || report.verdict === "discriminator-holds") process.exitCode = 0;
    else process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
