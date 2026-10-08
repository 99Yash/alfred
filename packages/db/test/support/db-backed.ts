/**
 * Skip guard for DB-backed suites: skip locally without a database, throw in CI.
 * A suite-level skip prints `# skipped 0`, so a CI job that reached no database
 * still exits 0. Throwing at module scope makes the file fail instead.
 *
 * Five copies, one per test tree, differing only in the CI job name they report
 * (`rootDir: "."` makes a cross-tree import a TS6059 error).
 * `db-backed-skip-hand-rolled` in `scripts/consolidation-rules.mjs` flags a hand-rolled skip.
 *
 * Reads `process.env` for presence only. `databaseEnv()` / `serverEnv()` parse every
 * variable, so an unrelated bad one would look like a missing `DATABASE_URL`.
 */

export type ServiceRequirement = "database" | "database+redis";

const REQUIRED_VARIABLES = {
  database: ["DATABASE_URL"],
  "database+redis": ["DATABASE_URL", "REDIS_URL"],
} satisfies Record<ServiceRequirement, readonly string[]>;

/** Pure, so `test/db-backed-guard.test.ts` can test the `fail` arm without touching `process.env`. */
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
      `${names} not set, but CI is set. The db-tests job must provide every service ` +
      `variable its suites need. Check the services: and env: blocks of the db-tests ` +
      `job in .github/workflows/ci.yml. A skip here would exit 0 and hide the failure.`,
  };
}

/** The `describe` `skip` value: `false` or a reason. Throws in CI. An empty value counts as absent. */
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
