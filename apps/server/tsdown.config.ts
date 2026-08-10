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
  // into this bundle, and pnpm links one of them, @alfred/http, through two
  // separate paths: apps/server/node_modules/@alfred/http and
  // packages/api/node_modules/@alfred/http, both pointing at packages/http.
  // With `symlinks: true` the resolver collapses both onto the real path, so
  // each file becomes one module in the output. With `false` it keeps the
  // symlinked location, so the same file can become two modules.
  //
  // packages/http/src/middleware/session-cache.ts holds module-level mutable
  // state — tokenCache, tokenInflight and the sweep timer — and its writer and
  // its readers now sit in different packages: invalidateSessionToken runs on
  // sign-out from packages/api/src/index.ts, while getSessionCached runs on
  // every request through authMacro. Two copies of that module means sign-out
  // clears a cache nobody reads, and the signed-out session stays valid until
  // the entry expires. Nothing else here depends on module identity, so this
  // one cache is the reason the setting is written down.
  //
  // `true` is already rolldown's default (it is oxc-resolver's). This states it
  // so the singleton stops riding a default nothing in the repo pins. No test
  // observes the built output, so this is a statement of the dependency, not a
  // guard on it.
  //
  // The function form is required. tsdown shallow-merges user input options
  // over its own ({ ...defaults, ...user }), and its defaults already set
  // `resolve: { alias }`; the object form would replace that whole object and
  // drop the alias channel. Spreading `options` and `options.resolve` keeps it.
  inputOptions: (options) => ({
    ...options,
    resolve: { ...options.resolve, symlinks: true },
  }),
  // jsdom (pulled in by isomorphic-dompurify, which @alfred/api uses for
  // sanitizing Gmail HTML bodies) is CommonJS. Bundling it into the
  // server's ESM output makes Node 22 throw ERR_AMBIGUOUS_MODULE_SYNTAX
  // on boot. Keep both packages external so they resolve from
  // node_modules at runtime instead of being inlined.
  //
  // sharp (used by @alfred/api for chat attachment image processing) is a
  // native module: at runtime it loads a platform-specific binary
  // (@img/sharp-linux-x64 on Railway) via its own resolver. Bundling it
  // breaks that resolution — prod crash-loops with "Could not load the
  // sharp module using the linux-x64 runtime". Keep it external so it
  // resolves the real binary from node_modules. Each external here must
  // also be a direct dependency of this package so pnpm links it into
  // apps/server/node_modules where the bundle can resolve it at runtime.
  external: ["isomorphic-dompurify", "jsdom", "sharp"],
});
