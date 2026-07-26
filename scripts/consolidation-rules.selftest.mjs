// Fixtures for the rules whose matching is not obvious by reading the regex.
//
// Why this exists: `unguarded-agent-run-status-write` shipped as a one-line
// regex over an idiom the formatter splits across four lines, so it matched
// zero of the repo's six `agent_runs` write sites and its clean run said
// "no drift" rather than "cannot see anything". A rule nobody has watched fire
// is an assertion, not enforcement. These fixtures make every `pnpm check` run
// the rule against the exact regression it was written for (the `markRunFailed`
// body removed in cf6cf2b1) plus the shapes it must NOT flag.
//
// Only add a fixture when the answer is load-bearing: a false positive would
// block a build and a false negative would let a real bug through.

import { matchChains } from "./consolidation-rules.mjs";

/** A source file the rule is not exempt in. */
const FILE = "packages/api/src/modules/agent/executor.ts";

/** @type {{name: string, caught: boolean, code: string}[]} */
const CASES = [
  {
    name: "D1 verbatim — markRunFailed, the write that resurrected cancelled runs (#530)",
    caught: true,
    code: `
async function markRunFailed(runId: string, error: string): Promise<void> {
  await db()
    .update(agentRuns)
    .set({
      status: "failed",
      // A comment inside the payload must not end the match.
      error: { message: sanitizeErrorMessage(error) },
      endedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}`,
  },
  {
    name: "nested error object BEFORE status — invisible to a brace-bounded regex",
    caught: true,
    code: `
  await tx
    .update(agentRuns)
    .set({ error: { message: m, step: s }, status: "failed" })
    .where(eq(agentRuns.id, id));`,
  },
  {
    name: "hand-collapsed one-liner",
    caught: true,
    code: `  await tx.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, id));`,
  },
  {
    name: "separate statements — agentSteps owns the status, agentRuns write is benign",
    caught: false,
    code: `
  await tx.update(agentRuns).set({ lastCheckpointAt: now }).where(eq(agentRuns.id, id));
  await tx
    .update(agentSteps)
    .set({ status: "completed" })
    .where(eq(agentSteps.id, stepRowId));`,
  },
  {
    name: "heartbeat — an agentRuns write with no status key",
    caught: false,
    code: `
  await db()
    .update(agentRuns)
    .set({ lastCheckpointAt: new Date() })
    .where(and(...conds));`,
  },
  {
    name: "a read filtered by status",
    caught: false,
    code: `  const rows = await tx.select().from(agentRuns).where(eq(agentRuns.status, "running"));`,
  },
  {
    name: "doc-comment example of the banned idiom",
    caught: false,
    code: `
/**
 * Never write it like this:
 *   await tx.update(agentRuns).set({ status: "failed" }).where(eq(agentRuns.id, id));
 */`,
  },
  {
    name: "drift-ok in the comment block above the chain",
    caught: false,
    code: `
  await tx
    // drift-ok: FOR UPDATE held since the SELECT above, status checked under it.
    .update(agentRuns)
    .set({ status: "failed" })
    .where(eq(agentRuns.id, id));`,
  },
];

/** @returns {string[]} One message per failed fixture; empty when all pass. */
export function selfTestFailures() {
  const failures = [];
  for (const { name, caught, code } of CASES) {
    const hits = matchChains(code, FILE, "gate");
    if (hits.length > 0 !== caught) {
      failures.push(
        caught
          ? `missed a case it must catch: ${name}`
          : `flagged a case it must ignore: ${name} (matched line ${hits[0].line})`,
      );
    }
  }
  return failures;
}
