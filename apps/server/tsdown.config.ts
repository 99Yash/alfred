import { defineConfig } from "tsdown";

export default defineConfig({
  // Second entry is a one-off prod backfill (2026-06-09). Bundled here so it
  // runs on prod with plain `node dist/scripts/backfill-triage-committed.js` —
  // the image has no `tsx`/loose `@alfred/*` sources. Remove after the run.
  entry: ["./src/index.ts", "./src/scripts/backfill-triage-committed.ts"],
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
