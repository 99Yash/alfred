// Fails when a package door exports a name that only test files reach.
//
// A door is a file that a workspace's `exports` map names, such as
// `packages/assistant/src/knowledge/index.ts` for `@alfred/assistant/knowledge`. A
// name on a door is public API: the next caller finds it there and copies the
// primitive. A test reaches a private name through its `src/` path instead (smell
// `no-barrel-export-for-test`).
//
// Knip answers the question in two runs. Both include the exports of entry files,
// because a door is an entry file and knip skips its exports by default:
//   - production mode, where test files are not entries: a name that no
//     production file reaches.
//   - default mode, where test files are entries: a name that nothing reaches.
// A name in the first set and not in the second has only test readers. Scripts
// and evals are production entries (the `!` suffix in knip.json), so a name that
// they read is not test-only.
//
// Plain `knip --production` does not answer the question. It skips the exports of
// an entry file, so a door that re-exports a test-only name hides it. It also
// reports a name that a test imports from an inner `src/` module, which is the
// correct form.
//
// A door named `test-support.ts` is exempt: it is a door for tests by its name,
// and tests in other workspaces import it. A name tagged `@internal` is exempt,
// because knip skips it in production mode.
//
// BASELINE lists the findings that were in the tree when the gate came in. The
// check fails on a finding that is not in the baseline, and on a baseline row
// that is no longer a finding, so the list only gets shorter.
//
// Usage: node scripts/check-test-only-exports.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportTargets, matchesSubpathKey } from "./package-exports.mjs";
import { listWorkspaces } from "./workspaces.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const BASELINE = "scripts/test-only-exports-baseline.json";

const KNIP = join(ROOT, "node_modules/.bin/knip");

const KNIP_ARGS = ["--include-entry-exports", "--include", "exports,types", "--reporter", "json"];

/**
 * The `file#name` key of each unused export and type that one knip run reports.
 *
 * @param {string[]} extraArgs
 * @returns {Set<string>}
 */
function knipUnused(extraArgs) {
  let stdout;

  try {
    stdout = execFileSync(KNIP, [...KNIP_ARGS, ...extraArgs], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Knip exits 1 when it reports an issue; the report is still on stdout.
    const output = error instanceof Error && "stdout" in error ? error.stdout : null;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reads the stdout of a child-process error, which has no schema
    if (typeof output !== "string" || output === "") throw error;
    stdout = output;
  }

  // A config file that knip loads can print a line (a dotenv banner) before the report.
  const start = stdout.indexOf('{"issues"');

  if (start === -1) throw new Error(`knip ${extraArgs.join(" ")} printed no JSON report`);
  const report = JSON.parse(stdout.slice(start));
  const keys = new Set();

  for (const issue of report.issues) {
    for (const item of [...issue.exports, ...issue.types]) keys.add(`${issue.file}#${item.name}`);
  }

  return keys;
}

/**
 * Each door as a repo-relative path pattern, where `*` matches as Node matches it.
 *
 * @returns {string[]}
 */
function doorPatterns() {
  const { workspaces, failures } = listWorkspaces(ROOT);

  if (failures.length > 0) throw new Error(failures.join("\n"));
  const patterns = [];

  for (const workspace of workspaces) {
    const manifest = JSON.parse(readFileSync(join(ROOT, workspace.manifest), "utf8"));

    if (manifest.exports === undefined) continue;

    for (const { target, kind } of exportTargets(manifest.exports).targets) {
      if (kind === "target" && target !== null && target.startsWith("./")) {
        patterns.push(`${workspace.dir}/${target.slice(2)}`);
      }
    }
  }

  return patterns;
}

const doors = doorPatterns();

/** @param {string} file */
const isDoor = (file) =>
  !file.endsWith("/test-support.ts") && doors.some((pattern) => matchesSubpathKey(pattern, file));

const production = knipUnused(["--production"]);

const everywhere = knipUnused([]);

const findings = [...production]
  .filter((key) => !everywhere.has(key) && isDoor(key.slice(0, key.indexOf("#"))))
  .toSorted();

/** @type {Record<string, string[]>} */
const baselineByFile = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8"));

const baseline = new Set(
  Object.entries(baselineByFile).flatMap(([file, names]) => names.map((name) => `${file}#${name}`)),
);

const added = findings.filter((key) => !baseline.has(key));

const found = new Set(findings);

const stale = [...baseline].filter((key) => !found.has(key)).toSorted();

if (added.length > 0 || stale.length > 0) {
  if (added.length > 0) {
    console.error("A package door exports a name that only test files reach:\n");

    for (const key of added) console.error(`- ${key.replace("#", ": ")}`);
    console.error(
      "\nDelete the name from the door. A test imports it from its `src/` module instead.\n" +
        "When the door declares the name itself, move it to an inner module, or delete it if production does not need it.\n",
    );
  }

  if (stale.length > 0) {
    console.error(`${BASELINE} lists a name that is no longer a finding:\n`);

    for (const key of stale) console.error(`- ${key.replace("#", ": ")}`);
    console.error("\nDelete the row, so the baseline only gets shorter.\n");
  }

  process.exit(1);
}

console.log(
  `check-test-only-exports: ${doors.length} door patterns, ${findings.length} baseline findings, no new finding.`,
);
