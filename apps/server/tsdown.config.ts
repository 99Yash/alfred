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
  external: ["isomorphic-dompurify", "jsdom"],
});
