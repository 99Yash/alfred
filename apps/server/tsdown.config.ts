import { defineConfig } from "tsdown";

export default defineConfig({
  // Script entries run on prod via `railway ssh -s server`. The image has no tsx, so bundle them.
  entry: [
    "./src/index.ts",
    // The PDF extractor runs the native parser in this child process, so it can kill it.
    "./src/extract-pdf-child.ts",
    // Separate, so `start` can preload it with `--import`. Sentry.init() must run before other libs load.
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
    "./src/scripts/backfills/backfill-triage-committed.ts",
    "./src/scripts/dry-runs/dry-run-triage-recategorize-committed.ts",
    "./src/scripts/dry-runs/dry-run-reply-reeval-reconcile.ts",
    "./src/scripts/repairs/repair-sent-mislabeled-triage-committed.ts",
    // Needs prod Redis. Its read-only sibling `dry-runs/triage-classification-watch.ts` has no
    // entry on purpose: it runs locally over the Railway tunnel.
    "./src/scripts/repairs/repair-triage-sender-miss-committed.ts",
    "./src/scripts/backfills/backfill-purge-document-facts-committed.ts",
    "./src/scripts/backfills/backfill-purge-relationship-junk-committed.ts",
    "./src/scripts/backfills/backfill-purge-graph-junk-committed.ts",
    "./src/scripts/backfills/backfill-org-affiliation-committed.ts",
    "./src/scripts/backfills/backfill-chat-compaction-committed.ts",
    "./src/scripts/probes/probe-chat-ttft.ts",
  ],
  format: "esm",
  outDir: "./dist",
  clean: true,
  // `scripts/sentry-release.mjs` uploads these so Sentry can unminify prod stack traces.
  sourcemap: true,
  noExternal: [/@alfred\/.*/],
  // Pin `symlinks: true` (already the default). pnpm links some @alfred/* packages through
  // several paths; `false` would bundle one module copy per path and fork module state
  // (the @alfred/db pool and heartbeat timer, the session cache).
  // Use the function form and return the object: tsdown shallow-merges options, so the
  // object form would drop its default `resolve.alias`.
  inputOptions: (options) => ({
    ...options,
    resolve: { ...options.resolve, symlinks: true },
  }),
  // jsdom (via isomorphic-dompurify) is CommonJS: bundled, Node throws ERR_AMBIGUOUS_MODULE_SYNTAX on boot.
  // @firecrawl/pdf-inspector and sharp load native binaries with their own resolver,
  // which bundling breaks (prod crash-loops).
  // Each external must also be a direct dependency here, so it resolves from node_modules.
  external: ["@firecrawl/pdf-inspector", "isomorphic-dompurify", "jsdom", "sharp"],
});
