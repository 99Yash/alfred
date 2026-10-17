// Fails when a plan under `docs/plans/` has no valid `status:` in its front matter.
//
// A plan is a snapshot (docs/plans/README.md), and its status is the one line a
// reader trusts to say whether the work is still open. `vercel-mcp-retirement.md`
// read "proposed" for three weeks after #1259 had swapped the transport it
// proposed, and work was planned from it. So the status is front matter with a closed
// vocabulary, and a plan without one fails the build. The check cannot tell
// whether the value is still true; it makes the claim exist and keeps it greppable.
//
// Usage: node scripts/check-plan-status.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listGitSourceFiles } from "./git-source-files.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PLAN_STATUSES = ["proposed", "in-progress", "done", "superseded"];

/** `null` when the text opens with a `---` block holding a known `status:`, else the reason. */
function planStatusFailure(text) {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);

  if (!frontMatter) return "no front matter (the file must open with a `---` block)";

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("status:"));

  if (!line) return "the front matter has no `status:` line";

  const value = line.slice("status:".length).trim();

  return PLAN_STATUSES.includes(value)
    ? null
    : `\`status: ${value}\` is not one of ${PLAN_STATUSES.join(", ")}`;
}

// A matcher that accepts everything passes a clean tree like one that works.
// Drive it on fixtures first, so "no failures" means the rule was applied.
const FIXTURES = [
  ["---\nstatus: done\n---\n# Plan\n", true],
  ["---\ntitle: x\nstatus: in-progress\n---\n", true],
  ["# Plan\n\nstatus: done\n", false],
  ["---\ntitle: x\n---\nstatus: done\n", false],
  ["---\nstatus: shipped\n---\n", false],
  ["---\nstatus:\n---\n", false],
];

const selfTest = FIXTURES.flatMap(([text, valid], index) =>
  (planStatusFailure(text) === null) === valid
    ? []
    : [`fixture ${index} should be ${valid ? "valid" : "refused"}`],
);

if (selfTest.length > 0) {
  console.error("plan-status self-test failed:\n");

  for (const failure of selfTest) console.error(`  ${failure}`);
  process.exit(1);
}

const plans = listGitSourceFiles(["docs/plans/*.md"], ROOT).filter(
  (file) => file !== "docs/plans/README.md",
);

// An empty walk is a moved directory, not a clean tree.
if (plans.length === 0) {
  console.error("check-plan-status: found no plan under docs/plans/, so it checked nothing.");
  process.exit(1);
}

const failures = plans.flatMap((file) => {
  const reason = planStatusFailure(readFileSync(join(ROOT, file), "utf8"));

  return reason ? [`${file}: ${reason}`] : [];
});

if (failures.length > 0) {
  console.error("Plans without a valid status:\n");

  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nOpen each plan with front matter that sets `status:` to one of " +
      `${PLAN_STATUSES.join(", ")}.` +
      "\nSet it from evidence (merged PRs, the code), not from the plan's own prose.",
  );
  process.exit(1);
}

console.log(`check-plan-status: ${plans.length} plans carry a valid status.`);
