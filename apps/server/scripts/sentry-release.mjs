// Post-build Sentry release step. Runs after `tsdown` in the server `build`
// script, so it fires during the Railway production build (where devDeps like
// @sentry/cli are still installed) and no-ops everywhere else.
//
// What it does, when SENTRY_AUTH_TOKEN is present:
//   1. create the release (the deployed commit SHA)
//   2. associate commits with it  -> Suspect Commits + "resolved in commit/PR"
//   3. inject debug IDs into ./dist and upload source maps -> unminified traces
//
// It is deliberately best-effort: a Sentry outage or a missing token must never
// break a deploy, so every step is wrapped and the process always exits 0.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const authToken = process.env.SENTRY_AUTH_TOKEN;
const org = process.env.SENTRY_ORG;
const project = process.env.SENTRY_PROJECT;
// Match the runtime release (Sentry.init({ release })). SENTRY_RELEASE is set in
// prod to ${{ RAILWAY_GIT_COMMIT_SHA }}; fall back to Railway's raw commit var.
const release = process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA;

if (!authToken) {
  console.log("[sentry-release] SENTRY_AUTH_TOKEN unset - skipping.");
  process.exit(0);
}
if (!org || !project) {
  console.warn(
    "[sentry-release] SENTRY_ORG/SENTRY_PROJECT unset - skipping upload.",
  );
  process.exit(0);
}

let bin;
try {
  // @sentry/cli ships the platform binary as an optional dep; getPath() resolves
  // it in the monorepo. v3 exports the class as a named `SentryCli`.
  bin = require("@sentry/cli").SentryCli.getPath();
} catch (err) {
  console.warn("[sentry-release] @sentry/cli not resolvable - skipping.", err);
  process.exit(0);
}

const env = { ...process.env, SENTRY_ORG: org, SENTRY_PROJECT: project };

/** Run a sentry-cli subcommand; log and swallow failures (never blocks deploy). */
function run(args) {
  try {
    execFileSync(bin, args, { stdio: "inherit", env });
    return true;
  } catch (err) {
    console.warn(`[sentry-release] \`${args.join(" ")}\` failed:`, err?.message);
    return false;
  }
}

console.log(
  `[sentry-release] org=${org} project=${project} release=${release || "(none)"}`,
);

// Source maps match by injected debug IDs, so this works even without a release
// name. Inject rewrites ./dist in place (same bundle that ships), then upload.
run(["sourcemaps", "inject", "./dist"]);
run([
  "sourcemaps",
  "upload",
  ...(release ? ["--release", release] : []),
  "./dist",
]);

// Commit association (Suspect Commits / "resolved in commit") needs the release
// name. Skip gracefully if the build didn't expose the commit SHA.
if (release) {
  run(["releases", "new", release]);
  run(["releases", "set-commits", release, "--auto", "--ignore-missing"]);
  run(["releases", "finalize", release]);
} else {
  console.warn(
    "[sentry-release] no SENTRY_RELEASE / RAILWAY_GIT_COMMIT_SHA - " +
      "uploaded source maps but skipped commit association.",
  );
}
process.exit(0);
