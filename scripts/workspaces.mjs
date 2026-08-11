// Which directories of this repository are workspaces, answered once.
//
// `scripts/` used to answer it five times: two `readdirSync` walks over hardcoded
// group literals (`["packages"]` in the browser fence, `["apps", "packages"]` in
// the architecture checker and again in the doc-symbol check) and two readings of
// `pnpm-workspace.yaml` layered on each other in the exports checker. The walks and
// the yaml readings disagreed, and the disagreement was not cosmetic: a second
// `apps/*` workspace was a workspace to three of them and invisible to the browser
// fence, so a browser app outside `apps/web` could take a Node-only runtime binding
// and leave `pnpm check` at exit 0.
//
// The yaml is the only authority here. A new workspace root joins every check in
// the same commit that declares it, and there is no group literal left to edit.
//
// Every shape this mini-parser cannot read is a reported failure and never a silent
// skip, because an enumeration that quietly comes back empty looks exactly like a
// clean tree from the outside — and it now looks that way to four checks at once
// rather than to one. `failures` is the reason each caller can still refuse.
//
// Resolution goes through git, never `existsSync`: a manifest that exists only in
// the author's worktree would otherwise enumerate a workspace nobody else has.
//
// This module is pure and has no CLI. `scripts/workspaces.selftest.mjs` is its only
// executor — `scripts/` has no CI test job and no tsconfig names the tree — and
// `check-web-boundaries.mjs` runs that suite before it trusts its own surface.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const MANIFEST = "package.json";

/**
 * The workspace globs `pnpm-workspace.yaml` declares, as written.
 *
 * Module-internal: a glob list is an implementation detail of the enumeration, and
 * a caller that reads the globs without resolving them is a sixth enumeration.
 */
function workspaceGlobs(root) {
  const failures = [];
  const path = join(root, WORKSPACE_FILE);

  if (!existsSync(path)) {
    failures.push(
      `${WORKSPACE_FILE} does not exist, so the set of workspaces is derived from nothing.`,
    );
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
 * @typedef {object} Workspace
 * @property {string} dir repo-relative directory, e.g. `packages/http`
 * @property {string} group the first path segment of `dir`, e.g. `apps` or `packages`
 * @property {string|null} name the manifest's `name`, `null` when it is absent or not a string
 * @property {string} source repo-relative `<dir>/src` — a path, not a claim that it exists
 * @property {string} manifest repo-relative path to the `package.json` that declared it
 */

/**
 * Every workspace the declared globs resolve, plus the globs and the refusals.
 *
 * The globs come back with the workspaces because a caller that needs the files
 * inside them takes one listing of the same globs, and re-parsing the yaml to get
 * them again would read one file twice.
 *
 * Only `name` is validated, because `name` is identity: it is the field a caller
 * matches an import specifier against, and a workspace without one cannot be the
 * target of an edge. Everything else in the manifest — the `exports` map, the
 * `check-types` script — is validated at the boundary that owns it, which already
 * reads the file. Two reads of a 1 KB manifest is the price of not handing back a
 * blob of `unknown` for four callers to reach into.
 *
 * A workspace whose manifest does not parse is still listed, with `name: null`, and
 * the unreadable manifest is reported. Both halves matter: a caller keyed on
 * identity must not see it, and a caller keyed on the directory (a guide file, a
 * doc) must still see the directory that undeniably exists.
 */
export function listWorkspaces(root) {
  const { globs, failures } = workspaceGlobs(root);
  if (globs.length === 0) return { workspaces: [], globs, failures };

  const manifests = listGitSourceFiles(
    globs.map((glob) => `${glob}/${MANIFEST}`),
    root,
  );
  if (manifests.length === 0) {
    failures.push(
      `the workspace globs (${globs.join(", ")}) list no ${MANIFEST} that git tracks, so there are no workspaces to read.`,
    );
    return { workspaces: [], globs, failures };
  }

  const workspaces = [];
  for (const manifest of manifests) {
    const dir = manifest.slice(0, -(MANIFEST.length + 1));

    let name = null;
    try {
      const parsed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
      if (parsed !== null && typeof parsed === "object" && typeof parsed.name === "string") {
        name = parsed.name;
      }
    } catch (error) {
      failures.push(
        `${manifest} is not readable as JSON (${error.message}), so the workspace it declares has no identity.`,
      );
    }

    const separator = dir.indexOf("/");
    workspaces.push({
      dir,
      group: separator === -1 ? dir : dir.slice(0, separator),
      name,
      source: `${dir}/src`,
      manifest,
    });
  }

  return { workspaces, globs, failures };
}
