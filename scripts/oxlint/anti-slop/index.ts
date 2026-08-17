import { eslintCompatPlugin } from "@oxlint/plugins";

import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";

/**
 * The subset of dmmulroy/anti-slop this repo adopts. See ./README.md for the
 * upstream commit, the sync procedure, and the measured reason each unvendored
 * rule stayed out.
 *
 * Every rule registered here is enabled at "error" in the root `.oxlintrc.json`
 * and had ZERO violations in `apps packages scripts` when it was adopted, so it
 * is a pure ratchet: it can only fail on code written after this point. Do not
 * register a rule here that the tree already violates — a rule nobody can keep
 * green either gets a wave of disable comments or gets demoted to a warning
 * nobody reads. Pay the violations down first, in their own change.
 */
const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-module-mocking": noModuleMockingRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-widen-then-assert": noWidenThenAssertRule,
  },
});

export default antiSlopPlugin;
