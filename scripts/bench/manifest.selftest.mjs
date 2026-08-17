// Self-test for `manifest.mjs`. Runs the validator over tampered fixtures and
// over the real seeded tasks, so a shape that degrades at seed time fails here.
//
// Usage: node scripts/bench/manifest.selftest.mjs

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManifest, repoRoot, tasksRoot, validateManifest } from "./manifest.mjs";

let failures = 0;

/** @param {boolean} condition @param {string} message */
function expect(condition, message) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${message}`);
}

const tmp = mkdtempSync(join(tmpdir(), "bench-manifest-"));
const dir = join(tmp, "t-a-1");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "prompt.md"), "do the thing\n");
writeFileSync(join(dir, "test.patch"), "diff --git a/a.test.ts b/a.test.ts\n");
writeFileSync(join(dir, "gold.patch"), "diff --git a/a.ts b/a.ts\n");

/** @returns {Record<string, unknown>} */
function validFixture() {
  return {
    id: "t-a-1",
    tier: "a",
    title: "Test task",
    base: "a".repeat(40),
    source: { kind: "pr", pr: 1, mergedAt: "2026-08-01T00:00:00Z" },
    promptFile: "t-a-1/prompt.md",
    testPatch: "t-a-1/test.patch",
    goldPatch: "t-a-1/gold.patch",
    hiddenFiles: ["a.test.ts"],
    verify: ["node a.selftest.mjs"],
    createdAt: "2026-08-16T00:00:00Z",
  };
}

const valid = validFixture();
expect(validateManifest(valid, tmp).length === 0, "valid fixture passes");

/** @param {Partial<Record<string, unknown>>} change @returns {string[]} */
function failuresFor(change) {
  return validateManifest({ ...validFixture(), ...change }, tmp);
}

expect(failuresFor({ id: "A-834" }).length > 0, "uppercase id rejected");
expect(failuresFor({ tier: "z" }).length > 0, "unknown tier rejected");
expect(failuresFor({ base: "abc" }).length > 0, "short base rejected");
expect(
  failuresFor({ source: { kind: "pr", pr: null, mergedAt: null } }).length > 0,
  "pr task with null pr rejected",
);
expect(
  failuresFor({ source: { kind: "synthetic", pr: null, mergedAt: null } }).length === 0,
  "synthetic source passes",
);
expect(failuresFor({ promptFile: "nope.md" }).length > 0, "missing promptFile rejected");
expect(failuresFor({ testPatch: null }).length > 0, "tier a without testPatch rejected");
expect(failuresFor({ goldPatch: "nope.patch" }).length > 0, "missing goldPatch rejected");
expect(failuresFor({ goldPatch: "prompt.md" }).length > 0, "patch with no diff header rejected");
expect(failuresFor({ hiddenFiles: [] }).length > 0, "tier a with empty hiddenFiles rejected");
expect(
  failuresFor({ hiddenFiles: ["a.test.ts", "a.test.ts"] }).length > 0,
  "duplicate hiddenFiles rejected",
);
expect(failuresFor({ verify: [] }).length > 0, "empty verify rejected");
expect(failuresFor({ verify: ["node x"] }).length === 0, "single verify command passes");
expect(failuresFor({ createdAt: "yesterday" }).length > 0, "bad createdAt rejected");

const tierC = {
  ...validFixture(),
  id: "c-foo",
  tier: "c",
  source: { kind: "synthetic", pr: null, mergedAt: null },
  testPatch: null,
  goldPatch: null,
  hiddenFiles: [],
  targetFiles: ["packages/contracts/src/tools.ts"],
};
expect(validateManifest(tierC, tmp).length === 0, "valid tier c fixture passes");
expect(
  failuresFor({ tier: "c", testPatch: "test.patch", hiddenFiles: [] }).length > 0,
  "tier c with testPatch rejected",
);
expect(
  failuresFor({ tier: "c", hiddenFiles: ["a.test.ts"] }).length > 0,
  "tier c with hiddenFiles rejected",
);

const root = repoRoot();
for (const id of ["a-834", "c-contracts-slack-action"]) {
  try {
    const { manifest } = readManifest(root, id);
    expect(manifest.id === id, `seed ${id} reads back`);
    expect(manifest.tier === "a" || manifest.tier === "c", `seed ${id} has a known tier`);
    expect(typeof manifest.verify[0] === "string", `seed ${id} has a verify command`);
  } catch (error) {
    failures += 1;
    console.error(
      `FAIL seed ${id} does not read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const taskDirs = [];
try {
  for (const entry of readdirSync(tasksRoot(root), { withFileTypes: true })) {
    if (entry.isDirectory()) taskDirs.push(entry.name);
  }
} catch {
  // The tasks directory does not exist yet; nothing to scan.
}

for (const id of taskDirs) {
  try {
    readManifest(root, id);
  } catch (error) {
    failures += 1;
    console.error(
      `FAIL seeded task ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures > 0) {
  console.error(`manifest selftest: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log(`manifest selftest: clean (${taskDirs.length} seeded task(s))`);
}
