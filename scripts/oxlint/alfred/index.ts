import { eslintCompatPlugin } from "@oxlint/plugins";

import { sha256OverJsonStringifyRule } from "./rules/sha256-over-json-stringify.ts";

/**
 * First-party Alfred rules: gates that need scope or AST structure a regex in
 * scripts/consolidation-rules.mjs cannot see. ./README.md says how this plugin
 * differs from the vendored anti-slop plugin.
 */
const alfredPlugin = eslintCompatPlugin({
  meta: { name: "alfred" },
  rules: {
    "sha256-over-json-stringify": sha256OverJsonStringifyRule,
  },
});

export default alfredPlugin;
