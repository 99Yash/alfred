/**
 * Use instead of a hand-rolled `{ skip: !process.env.DATABASE_URL }`.
 * Skips on a laptop with no Postgres. Throws in CI when a variable is missing, because
 * `node:test` reports a suite-level skip as `# skipped 0` and the job would exit 0.
 * Five copies exist, one per test tree (`rootDir: "."` blocks a shared import). They differ only in the CI job name.
 * Reads `process.env` directly: `databaseEnv()` and `serverEnv()` parse unrelated variables.
 */

/** Which services a suite needs before it can run. */
export type ServiceRequirement = "database" | "database+redis";

/** The variables each requirement needs present. */
const REQUIRED_VARIABLES = {
  database: ["DATABASE_URL"],
  "database+redis": ["DATABASE_URL", "REDIS_URL"],
} satisfies Record<ServiceRequirement, readonly string[]>;

/** The pure decision behind `dbBackedSkip`. */
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
      `${names} not set, but CI is set. The assistant-unit-tests job must provide every service ` +
      `variable its suites need. Check the services: and env: blocks of the assistant-unit-tests ` +
      `job in .github/workflows/ci.yml. A skip here would exit 0 and hide the failure.`,
  };
}

/**
 * Returns the `skip` value accepted by `describe`: `false` to run, or a reason
 * string to skip. Throws when CI lacks a required service variable.
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
