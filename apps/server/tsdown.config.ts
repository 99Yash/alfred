import { defineConfig } from "tsdown";

export default defineConfig({
  // Extra entries: committed one-off runs on prod via `railway ssh -s server`
  // (`node dist/scripts/<category>/<name>.js --commit`). The prod image has no
  // tsx/loose @alfred sources, so each script must be bundled.
  entry: [
    "./src/index.ts",
    // Separate entry (not inlined into index.js) so the prod `start` script can
    // preload it via `node --import ./dist/instrument.js` — Sentry.init() must
    // run before the instrumented libs load, and bundlers don't preserve import
    // order across inlined modules.
    "./src/instrument.ts",
    "./src/scripts/ops/trigger-cold-start-committed.ts",
    "./src/scripts/backfills/backfill-team-graph-committed.ts",
    "./src/scripts/backfills/backfill-retire-self-mail-committed.ts",
    "./src/scripts/backfills/backfill-retire-self-mail-aliases-committed.ts",
    "./src/scripts/backfills/backfill-label-self-mail-committed.ts",
    "./src/scripts/backfills/backfill-gmail-sent-committed.ts",
    "./src/scripts/backfills/backfill-gmail-observations-committed.ts",
    "./src/scripts/backfills/project-user-model-gmail-shadow-committed.ts",
    "./src/scripts/backfills/backfill-object-state-github-committed.ts",
    // Committing sibling of dry-run-triage-recategorize: deletes stale agent
    // todos and re-runs the real email-triage workflow so merged demotion slices
    // (sender-kind floor, #354 alarm, collabActivity) re-tag existing mail, not
    // just new mail. Bundled so it runs on prod via `railway ssh -s server`.
    "./src/scripts/backfills/backfill-triage-committed.ts",
    "./src/scripts/dry-runs/dry-run-triage-recategorize-committed.ts",
    "./src/scripts/dry-runs/dry-run-reply-reeval-reconcile.ts",
    "./src/scripts/repairs/repair-sent-mislabeled-triage-committed.ts",
    "./src/scripts/backfills/backfill-purge-document-facts-committed.ts",
    "./src/scripts/backfills/backfill-purge-relationship-junk-committed.ts",
    "./src/scripts/backfills/backfill-org-affiliation-committed.ts",
    "./src/scripts/backfills/backfill-chat-compaction-committed.ts",
    "./src/scripts/probes/probe-chat-ttft.ts",
  ],
  format: "esm",
  outDir: "./dist",
  clean: true,
  // Emit source maps so `sentry-cli` can unminify prod stack traces. The build
  // script injects debug IDs into these and uploads them (scripts/sentry-release.mjs).
  sourcemap: true,
  noExternal: [/@alfred\/.*/],
  // Pin symlink resolution. `noExternal` above inlines every @alfred/* package
  // into this bundle, and pnpm links several of them through more than one
  // path. Each package that declares a dependency gets its own symlink, so the
  // path count is the count of declaring packages inside this bundle graph.
  // @alfred/api left that graph with this app's dependency on it, which removed
  // the second path to @alfred/http: this app is now the only package in the
  // bundle that declares it. @alfred/db is still reached through eight paths and
  // @alfred/auth through two — each set points at one directory under packages/.
  // (@alfred/assistant does not reach @alfred/http;
  // scripts/check-module-architecture.mjs fails the build on that import.)
  // With `symlinks: true` the resolver collapses every path onto the
  // real one, so each source file becomes one module in the output. With
  // `false` it keeps the symlinked location, so one file becomes one module per
  // path that reaches it.
  //
  // Module-level mutable state is what makes that matter.
  // packages/http/src/middleware/session-cache.ts holds tokenCache,
  // tokenInflight and a 60s sweep timer. That cache is what made the class
  // explicit: while @alfred/api was in this bundle, @alfred/http was reached
  // through two links and a `symlinks: false` build produced two copies of
  // session-cache.ts. A duplicated copy could make sign-out clear one map
  // while requests read another, which would keep a signed-out session valid
  // for up to TOKEN_TTL_MS (10s). @alfred/http has one link today, so the live
  // case is @alfred/db — its _db/_pool/_heartbeatTimer would fork into two
  // pools and two heartbeat timers with shutdown closing one. Read this pin as
  // covering every @alfred/* module reached through more than one link, not
  // just the cache that made it explicit.
  //
  // `true` is already rolldown's default (it is oxc-resolver's). This states it
  // so nothing here rides a default the repo does not pin. No test observes the
  // built output, so this is a statement of the dependency, not a guard on it.
  //
  // Use the function form. tsdown shallow-merges user input options over its own
  // ({ ...defaults, ...user }) and its defaults set `resolve: { alias }`, so the
  // object form would replace that whole object; spreading `options.resolve`
  // keeps the alias channel for whoever adds an alias here (there is none
  // today). The returned object is load-bearing — a callback body that returns
  // nothing also type-checks, and drops the pin silently.
  inputOptions: (options) => ({
    ...options,
    resolve: { ...options.resolve, symlinks: true },
  }),
  // jsdom (pulled in by isomorphic-dompurify, which @alfred/assistant uses for
  // sanitizing Gmail HTML bodies) is CommonJS. Bundling it into the
  // server's ESM output makes Node 22 throw ERR_AMBIGUOUS_MODULE_SYNTAX
  // on boot. Keep both packages external so they resolve from
  // node_modules at runtime instead of being inlined.
  //
  // sharp (used by @alfred/assistant for chat attachment image processing) is a
  // native module: at runtime it loads a platform-specific binary
  // (@img/sharp-linux-x64 on Railway) via its own resolver. Bundling it
  // breaks that resolution — prod crash-loops with "Could not load the
  // sharp module using the linux-x64 runtime". Keep it external so it
  // resolves the real binary from node_modules. Each external here must
  // also be a direct dependency of this package so pnpm links it into
  // apps/server/node_modules where the bundle can resolve it at runtime.
  external: ["isomorphic-dompurify", "jsdom", "sharp"],
});
