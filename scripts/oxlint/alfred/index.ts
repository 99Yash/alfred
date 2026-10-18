import { eslintCompatPlugin } from "@oxlint/plugins";

import { noExportedHasherRule } from "./rules/no-exported-hasher.ts";
import { noFunctionWrapperShimRule } from "./rules/no-function-wrapper-shim.ts";
import { sha256OverJsonStringifyRule } from "./rules/sha256-over-json-stringify.ts";

/**
 * Alfred's own lint rules: first-party source, unlike the vendored anti-slop
 * set beside it. ./README.md says what belongs here and how a rule is proven.
 */
const alfredPlugin = eslintCompatPlugin({
  meta: { name: "alfred" },
  rules: {
    "no-exported-hasher": noExportedHasherRule,
    "no-function-wrapper-shim": noFunctionWrapperShimRule,
    "sha256-over-json-stringify": sha256OverJsonStringifyRule,
  },
});

export default alfredPlugin;
