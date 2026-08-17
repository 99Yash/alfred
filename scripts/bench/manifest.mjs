// The task manifest: the declarative shape of a benchmark task, and its
// validator. A task is a directory under `scripts/bench/tasks/<id>/` that holds
// `manifest.json` and `prompt.md` plus, for history tasks, the split patches.
// See `docs/research/ai-coding-benchmark-v1.md` for the design.
//
// The validator is pure and touches no state, so seeding, running, and grading
// share one definition of "what a task is".

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * @typedef {"a" | "c"} Tier
 *
 * @typedef {object} TaskSource
 * @property {"pr" | "synthetic"} kind Where the task came from.
 * @property {number | null} pr The GitHub PR number, or null for a synthetic task.
 * @property {string | null} mergedAt The PR merge date in ISO form, or null for a synthetic task.
 *
 * @typedef {object} TaskManifest
 * @property {string} id The stable id, `a-834`-style.
 * @property {Tier} tier The tier. `a` is a real merged PR, `c` is a structural change.
 * @property {string} title One line that names the task for humans.
 * @property {string} base The full commit sha the worktree starts from.
 * @property {TaskSource} source The origin of the task.
 * @property {string} promptFile Repo-relative markdown prompt.
 * @property {string | null} testPatch Repo-relative patch that carries the hidden tests. Null for tier `c`.
 * @property {string | null} goldPatch Repo-relative reference solution. Null for tier `c`.
 * @property {string[]} hiddenFiles Repo-relative paths the agent must not edit.
 * @property {string[]} verify Shell commands that prove the task complete, run in the worktree.
 * @property {string[]} targetFiles Repo-relative files the agent must modify. Tier c only.
 * @property {string} createdAt ISO timestamp of task creation.
 */

/** Repo-relative roots. Each one exists on disk, so `check:script-paths` passes. */
const BENCH = "scripts/bench";
const TASKS = "scripts/bench/tasks";
const RUNS = "references/bench";

/** Every valid patch carries a `diff --git` line. */
export const PATCH_HEADER = "diff --git ";

const TIERS = new Set(["a", "c"]);
const SOURCE_KINDS = new Set(["pr", "synthetic"]);

/** @param {string} root @returns {string} */
export function benchRoot(root) {
  return join(root, BENCH);
}

/** @param {string} root @returns {string} */
export function tasksRoot(root) {
  return join(root, TASKS);
}

/** @param {string} root @param {string} id @returns {string} */
export function taskDir(root, id) {
  return join(root, TASKS, id);
}

/** @param {string} root @returns {string} */
export function runsRoot(root) {
  return join(root, RUNS);
}

/** The repo root, derived from this file rather than the process cwd. @returns {string} */
export function repoRoot() {
  return resolve(import.meta.dirname, "..", "..");
}

/**
 * Validate a manifest value. Pure: returns failure descriptions, touches nothing.
 *
 * @param {unknown} value
 * @param {string} root
 * @returns {string[]} Failure descriptions. Empty means valid.
 */
export function validateManifest(value, root) {
  const failures = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["manifest is not an object"];
  }
  const m = /** @type {Record<string, unknown>} */ (value);

  if (typeof m.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.id)) {
    failures.push(`id must be a lowercase slug like "a-834", got ${JSON.stringify(m.id)}`);
  }

  if (typeof m.tier !== "string" || !TIERS.has(m.tier)) {
    failures.push(`tier must be one of ${[...TIERS].join(", ")}, got ${JSON.stringify(m.tier)}`);
  }

  if (typeof m.title !== "string" || m.title.trim() === "") {
    failures.push("title must be a non-empty string");
  }

  if (typeof m.base !== "string" || !/^[0-9a-f]{40}$/.test(m.base)) {
    failures.push(`base must be a full 40-hex commit sha, got ${JSON.stringify(m.base)}`);
  }

  if (typeof m.source !== "object" || m.source === null || Array.isArray(m.source)) {
    failures.push("source must be an object");
  } else {
    const source = /** @type {Record<string, unknown>} */ (m.source);
    if (typeof source.kind !== "string" || !SOURCE_KINDS.has(source.kind)) {
      failures.push(
        `source.kind must be one of ${[...SOURCE_KINDS].join(", ")}, got ${JSON.stringify(source.kind)}`,
      );
    }
    if (source.kind === "pr") {
      if (typeof source.pr !== "number" || !Number.isInteger(source.pr) || source.pr <= 0) {
        failures.push(
          `source.pr must be a positive integer for a pr task, got ${JSON.stringify(source.pr)}`,
        );
      }
      if (typeof source.mergedAt !== "string" || source.mergedAt === "") {
        failures.push("source.mergedAt must be a non-empty ISO string for a pr task");
      }
    } else {
      if (source.pr !== null) failures.push("source.pr must be null for a synthetic task");
      if (source.mergedAt !== null)
        failures.push("source.mergedAt must be null for a synthetic task");
    }
  }

  if (typeof m.promptFile !== "string" || m.promptFile === "") {
    failures.push("promptFile must be a non-empty repo-relative path");
  } else if (!existsSync(join(root, m.promptFile))) {
    failures.push(`promptFile does not exist on disk: ${m.promptFile}`);
  }

  const tier = m.tier;
  if (tier === "a") {
    for (const key of ["testPatch", "goldPatch"]) {
      const patch = m[key];
      if (typeof patch !== "string" || patch === "") {
        failures.push(`${key} must be a non-empty repo-relative path for tier a`);
        continue;
      }
      if (!existsSync(join(root, patch))) {
        failures.push(`${key} does not exist on disk: ${patch}`);
      } else if (!readFileSync(join(root, patch), "utf8").includes(PATCH_HEADER)) {
        failures.push(`${key} carries no ${PATCH_HEADER.trim()} header: ${patch}`);
      }
    }
    if (!Array.isArray(m.hiddenFiles) || m.hiddenFiles.length === 0) {
      failures.push("hiddenFiles must be a non-empty array for tier a");
    }
  }
  if (tier === "c") {
    if (m.testPatch !== null) failures.push("testPatch must be null for tier c");
    if (m.goldPatch !== null) failures.push("goldPatch must be null for tier c");
    if (Array.isArray(m.hiddenFiles) && m.hiddenFiles.length > 0) {
      failures.push("hiddenFiles must be empty for tier c: there is no gold answer to protect");
    }
    if (!Array.isArray(m.targetFiles) || m.targetFiles.length === 0) {
      failures.push("targetFiles must be a non-empty array for tier c");
    }
  }

  if (!Array.isArray(m.hiddenFiles)) {
    failures.push("hiddenFiles must be an array of repo-relative paths");
  } else {
    const seen = new Set();
    for (const file of m.hiddenFiles) {
      if (typeof file !== "string" || file === "") {
        failures.push("hiddenFiles entries must be non-empty strings");
      } else if (seen.has(file)) {
        failures.push(`hiddenFiles lists ${file} twice`);
      }
      seen.add(file);
    }
  }

  if (!Array.isArray(m.verify) || m.verify.length === 0) {
    failures.push("verify must be a non-empty array of shell commands");
  } else {
    for (const command of m.verify) {
      if (typeof command !== "string" || command.trim() === "") {
        failures.push("verify entries must be non-empty shell commands");
      }
    }
  }

  if (typeof m.createdAt !== "string" || Number.isNaN(Date.parse(m.createdAt))) {
    failures.push(`createdAt must be an ISO timestamp, got ${JSON.stringify(m.createdAt)}`);
  }

  return failures;
}

/**
 * Load and validate one task.
 *
 * @param {string} root
 * @param {string} id
 * @returns {{ manifest: TaskManifest, dir: string }}
 */
export function readManifest(root, id) {
  const dir = taskDir(root, id);
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) throw new Error(`no manifest at ${file}`);
  const value = JSON.parse(readFileSync(file, "utf8"));
  const failures = validateManifest(value, root);
  if (failures.length > 0) {
    throw new Error(`task ${id} has an invalid manifest:\n- ${failures.join("\n- ")}`);
  }
  return { manifest: /** @type {TaskManifest} */ (value), dir };
}

/** The paths a patch touches, taken from its `diff --git a/…` lines. @param {string} patch @returns {string[]} */
export function patchPaths(patch) {
  return [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1] ?? "");
}

/**
 * True when the path belongs to the hidden test patch rather than the gold
 * patch. Mirrors the repo's naming: `*.test.*`, `*.spec.*`, `*.selftest.*`.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isTestFile(path) {
  return (
    path.startsWith("test/") ||
    path.includes("/test/") ||
    path.includes("/__tests__/") ||
    /\.(test|spec|selftest)\.[a-z0-9]+$/i.test(path)
  );
}
