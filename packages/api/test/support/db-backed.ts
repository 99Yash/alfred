/**
 * The guard a DB-backed suite in this tree uses instead of a hand-rolled
 * `{ skip: !process.env.DATABASE_URL }`.
 *
 * THERE ARE THREE COPIES, one per test tree that needs one: this one for
 * `api-tests`, `packages/http/test/support/db-backed.ts` for `http-tests`, and
 * `packages/assistant/test/support/db-backed.ts` for `assistant-unit-tests`.
 * They differ only in the job name in the fail message.
 * `packages/api/tsconfig.test.json` sets `rootDir: "."`, so a relative reach
 * into another package's test tree is a TS6059 error by design — the copy is
 * deliberate, not an oversight. Promotion to a workspace package was measured
 * and rejected: `packages/db/test` needs no copy because it FAILS LOUDLY on an
 * absent service instead of skipping.
 *
 * WHY THIS EXISTS. A skip count cannot detect an `api-tests` job that reached
 * no database. `node:test` prints `# skipped 0` for a SUITE-level skip —
 * `describe("…", { skip: SKIP }, …)` — because the subtests inside a skipped
 * `describe` are never registered, so they land in neither `# tests` nor
 * `# skipped`. A run with `DATABASE_URL` unset therefore prints `# fail 0` and
 * `# skipped 0` and exits 0, which is indistinguishable from a run that
 * reached Postgres. Do not guard this tree by reading a number.
 *
 * WHAT REPLACES IT. `dbBackedSkip` skips on a developer machine that has no
 * Postgres, and THROWS when `CI` is set and a required variable is absent. The
 * throw fires at module scope of the suite file, so `node:test` reports the
 * file as a failing test and the job exits non-zero. That is the whole
 * mechanism: no count, no magic number.
 *
 * SCOPE. A new DB-backed suite that hand-rolls its own `{ skip }` on a service
 * variable no longer goes quiet: the `db-backed-skip-hand-rolled` rule in
 * `scripts/consolidation-rules.mjs` fails `pnpm check` on it and names this
 * helper, and `.claude/hooks/helper-hints.mjs` names it from the same row while
 * the line is being written. The rule polices `DATABASE_URL` and `REDIS_URL`
 * over every `packages/<name>/test/` and `apps/<name>/test/` tree. It is tier 2,
 * not tier 1: an author can still build the variable name at runtime, and
 * `// drift-ok: <reason>` is always available. It stops the accident.
 *
 * This module reads `process.env` DIRECTLY and asks only about PRESENCE, not
 * validity. It deliberately does not call `databaseEnv()` / `serverEnv()`:
 * those parse every variable at once and memoize, so one unrelated absent or
 * malformed variable would read as an absent `DATABASE_URL` — the same class of
 * quiet miscount this module exists to delete.
 */

/** Which services a suite needs before it can run. */
export type ServiceRequirement = "database" | "database+redis";

/** The variables each requirement needs present. */
const REQUIRED_VARIABLES: Record<ServiceRequirement, readonly string[]> = {
  database: ["DATABASE_URL"],
  "database+redis": ["DATABASE_URL", "REDIS_URL"],
};

/**
 * The pure decision. Total over three arms, reads no environment, and is the
 * seam `test/db-backed-guard.test.ts` drives — the `fail` arm can be tested
 * without mutating `process.env`.
 */
export function decideDbBackedSkip(input: {
  readonly missing: readonly string[];
  readonly ci: boolean;
}): { kind: "run" } | { kind: "skip"; reason: string } | { kind: "fail"; message: string } {
  if (input.missing.length === 0) return { kind: "run" };

  const names = input.missing.join(", ");
  if (!input.ci) {
    return { kind: "skip", reason: `${names} not set — skipping DB-backed test` };
  }
  return {
    kind: "fail",
    message:
      `${names} not set, but CI is set. The api-tests job must provide every service ` +
      `variable its suites need. Check the services: and env: blocks of the api-tests ` +
      `job in .github/workflows/ci.yml. A skip here would exit 0 and hide the failure.`,
  };
}

/**
 * The env-reading door. Returns the `skip` value a `describe` option takes:
 * `false` to run, or a reason string to skip. Throws when `CI` is set and a
 * required variable is absent. An empty value counts as absent.
 */
export function dbBackedSkip(requires: ServiceRequirement): false | string {
  const missing = REQUIRED_VARIABLES[requires].filter((name) => !process.env[name]);
  const decision = decideDbBackedSkip({ missing, ci: Boolean(process.env["CI"]) });

  switch (decision.kind) {
    case "run":
      return false;
    case "skip":
      return decision.reason;
    case "fail":
      throw new Error(decision.message);
  }
}
