import { defineConfig } from "tsdown";

export default defineConfig({
  // Second entry: a committed one-off run on prod via `railway ssh -s server`
  // (`node dist/scripts/trigger-cold-start-committed.js --commit`). The prod
  // image has no tsx/loose @alfred sources, so the script must be bundled.
  entry: ["./src/index.ts", "./src/scripts/trigger-cold-start-committed.ts"],
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
