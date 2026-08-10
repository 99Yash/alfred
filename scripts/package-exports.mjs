// The rule behind `pnpm check:exports`: every subpath a workspace advertises in
// its `exports` map must point at a file that git lists.
//
// A package's `exports` map is that package's own statement of its public doors,
// and nothing in this repo re-derives it. Eight `@alfred/api` subpaths pointed at
// files deleted two campaigns earlier and no gate noticed — not `tsc`, not the
// architecture checker, not `pnpm check`. `tsc` never reads a map entry nobody
// imports; the architecture checker derives edges from import specifiers, so a
// door with no callers is invisible to it. They were found by eye. This is the
// gate that makes the ninth one cheap.
//
// Resolution goes through git, never `existsSync`: a file that exists only in the
// author's worktree would otherwise pass a gate green for a tree nobody else has.
//
// The rules live here so fixtures can drive them; `check-package-exports.mjs` is
// the enforcing consumer, and `package-exports.selftest.mjs` is their only
// executor — `scripts/` has no CI test job and no tsconfig names the tree.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const MANIFEST = "package.json";

/**
 * The workspace globs `pnpm-workspace.yaml` declares, as written.
 *
 * Deriving the list rather than hardcoding `packages/*` means a new workspace
 * root joins this check in the same commit that declares it. Every shape this
 * mini-parser cannot read is a reported failure and never a silent skip, because
 * a glob list that quietly comes back empty looks exactly like a clean tree.
 */
export function workspaceGlobs(root) {
  const failures = [];
  const path = join(root, WORKSPACE_FILE);

  if (!existsSync(path)) {
    failures.push(`${WORKSPACE_FILE} does not exist, so the set of workspaces is derived from nothing.`);
    return { globs: [], failures };
  }

  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line));
  if (start === -1) {
    failures.push(
      `${WORKSPACE_FILE} has no top-level \`packages:\` sequence, so the set of workspaces is derived from nothing.`,
    );
    return { globs: [], failures };
  }

  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (!item) break; // A line at column 0 ends the sequence.
    const value = item[1].replace(/^["']|["']$/g, "");
    if (value.startsWith("!")) {
      failures.push(
        `${WORKSPACE_FILE} excludes \`${value}\`, a shape this check cannot model — it would report a workspace that pnpm does not have.`,
      );
      continue;
    }
    globs.push(value);
  }

  if (globs.length === 0) {
    failures.push(
      `${WORKSPACE_FILE}'s \`packages:\` sequence lists no glob, so the set of workspaces is empty.`,
    );
  }
  return { globs, failures };
}

/**
 * Every workspace manifest git lists, plus the globs that found them.
 *
 * The globs come back with the manifests because the caller needs the same list
 * to take its one listing of the workspace trees, and re-parsing
 * `pnpm-workspace.yaml` to get them again would read one file twice.
 */
export function workspaceManifests(root) {
  const { globs, failures } = workspaceGlobs(root);
  if (globs.length === 0) return { manifests: [], globs, failures };

  const manifests = listGitSourceFiles(
    globs.map((glob) => `${glob}/${MANIFEST}`),
    root,
  );
  if (manifests.length === 0) {
    failures.push(
      `the workspace globs (${globs.join(", ")}) list no ${MANIFEST} that git tracks, so this check has nothing to read.`,
    );
  }
  return { manifests, globs, failures };
}

/**
 * Flatten one `exports` map into the targets it advertises.
 *
 * The map has four legal shapes at every level — a target string, an array of
 * fallbacks, a condition object, and `null` — and they nest. `null` is a
 * deliberate block (`@alfred/db` uses one to seal `./credential-envelope`), so it
 * is carried through as its own kind rather than dropped, which keeps a caller
 * from reading a blocked subpath as an unchecked one.
 *
 * The result shape is uniform: a malformed leaf is a failure that does not
 * discard the well-formed siblings beside it.
 */
export function exportTargets(exportsValue) {
  const targets = [];
  const failures = [];

  if (isSubpathMap(exportsValue)) {
    for (const [subpath, entry] of Object.entries(exportsValue)) {
      visitConditions(entry, subpath, targets, failures);
    }
  } else {
    visitConditions(exportsValue, ".", targets, failures);
  }

  return { targets, failures };
}

function isSubpathMap(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("."));
}

function visitConditions(value, subpath, targets, failures) {
  if (value === null) {
    targets.push({ subpath, target: null, kind: "blocked" });
    return;
  }
  if (typeof value === "string") {
    targets.push({ subpath, target: value, kind: "target" });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      failures.push(`"${subpath}" is an empty array, so it advertises a subpath that resolves to nothing`);
      return;
    }
    for (const element of value) visitConditions(element, subpath, targets, failures);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      failures.push(`"${subpath}" is an empty object, so it advertises a subpath that resolves to nothing`);
      return;
    }
    if (keys.some((key) => key.startsWith("."))) {
      failures.push(
        `"${subpath}" mixes subpath keys into a condition object, which the exports spec forbids`,
      );
      return;
    }
    for (const key of keys) visitConditions(value[key], subpath, targets, failures);
    return;
  }
  failures.push(
    `"${subpath}" maps to ${JSON.stringify(value)}, which is neither a target string, an array, a condition object, nor null`,
  );
}

/**
 * Why one target resolves to nothing, or `null` when it resolves.
 *
 * `listed` is one listing of the whole workspace, not one `git ls-files` per
 * target: a target whose parent directory is gone makes git print
 * `warning: could not open directory ...` onto this check's own stderr, and a
 * gate whose failure output opens with a raw git warning reads like a crash.
 *
 * A wildcard is a non-emptiness assertion and must not be sold as a narrowness
 * one. Node matches `*` across `/`, so this does too — by saying so, rather than
 * by relying on a git pathspec to agree.
 */
export function targetProblem(target, packageDir, listed) {
  if (!target.startsWith("./")) {
    return 'does not start with "./", which the exports spec requires of a target';
  }

  const stars = target.split("*").length - 1;
  if (stars > 1) {
    return 'holds more than one "*", which the exports spec forbids';
  }

  const path = `${packageDir}/${target.slice(2)}`;
  if (path.split("/").includes("..")) {
    return "escapes its own package directory";
  }

  if (stars === 0) {
    return listed.has(path) ? null : "resolves to no file git lists";
  }

  const [before, after] = path.split("*");
  const pattern = new RegExp(`^${escapeRegExp(before)}.*${escapeRegExp(after)}$`);
  for (const file of listed) {
    if (pattern.test(file)) return null;
  }
  return "matches no file git lists";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The whole check: every advertised target in every workspace manifest.
 *
 * `checked` counts every non-blocked target examined, failing ones included, so a
 * `checked` of 0 means this read nothing rather than that everything passed —
 * which is why it is itself a failure.
 */
export function packageExportsFailures(root) {
  const { manifests, globs, failures } = workspaceManifests(root);
  if (manifests.length === 0) return { checked: 0, blocked: 0, failures };

  const listed = new Set(listGitSourceFiles(globs, root));
  let checked = 0;
  let blocked = 0;
  let mapped = 0;

  for (const manifest of manifests) {
    const packageDir = manifest.slice(0, -(MANIFEST.length + 1));

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    } catch (error) {
      failures.push(`${manifest} is not readable as JSON (${error.message}), so its exports map cannot be checked.`);
      continue;
    }

    if (parsed === null || typeof parsed !== "object" || !("exports" in parsed)) continue;
    mapped += 1;

    const { targets, failures: shapeFailures } = exportTargets(parsed.exports);
    for (const failure of shapeFailures) failures.push(`${manifest} · ${failure}.`);

    for (const { subpath, target, kind } of targets) {
      if (kind === "blocked") {
        blocked += 1;
        continue;
      }
      checked += 1;
      const problem = targetProblem(target, packageDir, listed);
      if (problem) failures.push(`${manifest} · "${subpath}" → "${target}" ${problem}.`);
    }
  }

  if (mapped === 0) {
    failures.push(
      `none of the ${manifests.length} workspace manifests carries an "exports" map, so this check examined nothing.`,
    );
  } else if (checked === 0) {
    failures.push(
      `${mapped} workspace manifest(s) carry an "exports" map and not one advertised a target, so this check examined nothing.`,
    );
  }

  return { checked, blocked, failures };
}
