import { defineConfig } from "tsdown";

export default defineConfig({
  // Extra entries: committed one-off runs on prod via `railway ssh -s server`
  // (`node dist/scripts/<name>.js --commit`). The prod image has no tsx/loose
  // @alfred sources, so each script must be bundled.
  entry: [
    "./src/index.ts",
    // Separate entry (not inlined into index.js) so the prod `start` script can
    // preload it via `node --import ./dist/instrument.js` — Sentry.init() must
    // run before the instrumented libs load, and bundlers don't preserve import
    // order across inlined modules.
    "./src/instrument.ts",
    "./src/scripts/trigger-cold-start-committed.ts",
    "./src/scripts/backfill-team-graph-committed.ts",
    "./src/scripts/backfill-retire-self-mail-committed.ts",
    "./src/scripts/backfill-object-state-github-committed.ts",
    "./src/scripts/dry-run-triage-recategorize-committed.ts",
    "./src/scripts/dry-run-reply-reeval-reconcile.ts",
    "./src/scripts/repair-sent-mislabeled-triage-committed.ts",
  ],
  format: "esm",
  outDir: "./dist",
  clean: true,
  noExternal: [/@alfred\/.*/],
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
