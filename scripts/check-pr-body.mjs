// Fails when the pull request for this branch does not carry the four sections
// `CLAUDE.md` asks for.
//
// This is a check about a DOCUMENT, not about source, and it is the only gate in the
// repo that reads GitHub rather than the working tree. It runs `gh`, so it fails
// CLOSED: `gh` missing, unauthenticated, rate-limited, or pointed at a branch with no
// pull request is a FAILURE, never a pass. A checker that reports success because it
// could not ask is the exact fail-open shape this repo's other checks are written
// against.
//
// It is wired into `check:ci` rather than given its own CI job because it costs one
// `gh pr view` and one process spawn, and because `check:ci` is already the required
// chain in the `main protection` ruleset.
//
// The grammar and the rule live in ./pr-body.mjs so fixtures can exercise them; this
// file is the enforcing consumer.
//
// Usage: node scripts/check-pr-body.mjs [ref]

import { spawnSync } from "node:child_process";

import { prBodyFailures, viewArguments } from "./pr-body.mjs";
import { prBodySelfTestFailures } from "./pr-body.selftest.mjs";

// A clean run of a scan that read nothing is indistinguishable from a clean run of a
// scan that works. Drive the fixtures first, so "the body complies" means "looked and
// found it compliant" rather than "looked at nothing".
const selfTest = prBodySelfTestFailures();

if (selfTest.length > 0) {
  console.error("pr-body self-test failed:\n");

  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the grammar before trusting this check.");
  process.exit(1);
}

const ref = process.argv[2] ?? "HEAD";

const invocation = `gh ${viewArguments(ref).join(" ")}`;

const read = spawnSync("gh", viewArguments(ref), { encoding: "utf8" });

// 128 is git's "the tool is not there" and gh's own code for a failed invocation alike.
// Both mean the question went unasked, which is a failure here rather than a pass.

if (read.error !== undefined) {
  console.error(`${invocation} did not run (${read.error.message}).`);
  console.error(
    "This check asks GitHub for the pull request body, so without `gh` on PATH it can examine nothing. A pass over an unasked question is worse than no check at all.\n",
  );
  process.exit(1);
}

if (read.status !== 0) {
  console.error(`${invocation} exited ${read.status} rather than 0.`);

  if (read.stderr.trim() !== "") console.error(read.stderr.trim());

  console.error(
    "No pull request, no auth, and a rate limit all land here. All three mean the body went unread, so this check reports red rather than reading an empty answer as compliance.\n",
  );
  process.exit(1);
}

let pr;

try {
  pr = JSON.parse(read.stdout);
} catch (error) {
  console.error(
    `${invocation} did not emit JSON (${error instanceof Error ? error.message : String(error)}).`,
  );
  console.error(
    "Its output shape is not a contract this repo can rely on, so a change to it must redden the check.\n",
  );
  process.exit(1);
}

// `gh pr view` exits non-zero with no pull request, so reaching here means one was
// found — but the shape is still `unknown` until it is checked, and a shape this reader
// does not recognize must not read as an empty body.
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- walks gh pr view --json output; fails closed
if (pr === null || typeof pr !== "object" || Array.isArray(pr)) {
  console.error(`${invocation} emitted ${JSON.stringify(pr)} rather than a pull request object.`);
  process.exit(1);
}

if (pr.state !== "OPEN") {
  console.log(
    `PR #${pr.number} is ${String(pr.state).toLowerCase()}; the body check applies to open pull requests.`,
  );
  process.exit(0);
}

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- walks gh pr view --json output; fails closed
if (typeof pr.body !== "string" || typeof pr.title !== "string") {
  console.error(
    `PR #${pr.number} carries no readable title/body (body is ${JSON.stringify(pr.body)}), so this check would pass over a body nobody examined.`,
  );
  process.exit(1);
}

const result = prBodyFailures({ title: pr.title, body: pr.body });

if (result.ok) {
  console.log(`PR #${pr.number} body carries all four sections CLAUDE.md asks for.`);
  process.exit(0);
}

console.error(`PR #${pr.number} body — ${pr.title}`);

if (result.missing.length > 0) {
  console.error(`Missing section(s): ${result.missing.join(", ")}`);
}

if (result.reason !== null) console.error(result.reason);

console.error(
  "\nCLAUDE.md asks for these four sections so a reviewer who knows the Alfred product but not this flow can read the diff's claims: `Where this change sits`, `Why this change is needed`, `What this change does`, `Preserved behavior`. Heading style is free — `### Why this change is needed`, `**Why this change is needed**` and `Why this change is needed:` all count. What is checked is that each claim is findable.\n",
);

process.exit(1);
