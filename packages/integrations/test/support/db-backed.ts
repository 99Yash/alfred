/**
 * Skip guard for DB-backed suites. Use it instead of a hand-rolled `{ skip: !process.env.DATABASE_URL }`.
 * Five packages keep a copy; they differ only in the CI job name (`rootDir` blocks a shared import).
 * A suite-level skip prints `# skipped 0`, so a CI job with no database looks green.
 * This guard throws in CI instead. It reads `process.env` directly: `serverEnv()` parses everything.
 */

export type ServiceRequirement = "database" | "database+redis";

const REQUIRED_VARIABLES = {
  database: ["DATABASE_URL"],
  "database+redis": ["DATABASE_URL", "REDIS_URL"],
} satisfies Record<ServiceRequirement, readonly string[]>;

/** Pure, so `db-backed-guard.test.ts` can test the `fail` arm without editing `process.env`. */
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
      `${names} not set, but CI is set. The leaf-db-tests job must provide every service ` +
      `variable its suites need. Check the services: and env: blocks of the leaf-db-tests ` +
      `job in .github/workflows/ci.yml. A skip here would exit 0 and hide the failure.`,
  };
}

/** Return the `describe` skip option: `false` to run, or a reason. Throws in CI if a variable is missing. */
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
