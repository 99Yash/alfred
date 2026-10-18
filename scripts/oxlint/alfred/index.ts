import { eslintCompatPlugin } from "@oxlint/plugins";

import { noFunctionWrapperShimRule } from "./rules/no-function-wrapper-shim.ts";

/**
 * Alfred's own lint rules: first-party source, unlike the vendored anti-slop
 * set beside it. ./README.md says what belongs here and how a rule is proven.
 */
const alfredPlugin = eslintCompatPlugin({
  meta: { name: "alfred" },
  rules: {
    "no-function-wrapper-shim": noFunctionWrapperShimRule,
  },
});

export default alfredPlugin;
