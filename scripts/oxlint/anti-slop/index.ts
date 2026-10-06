import { eslintCompatPlugin } from "@oxlint/plugins";

import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";

/**
 * The subset of dmmulroy/anti-slop this repo adopts. See ./README.md for the
 * upstream commit, the sync procedure, and the measured reason each excluded
 * rule stayed out.
 *
 * Eleven rules are enabled at "error" in .oxlintrc.json (pure ratchets: zero
 * violations at adoption, driven to zero at warn and promoted, or promoted
 * after a by-surface scoping with test/eval, ops-scripts, and honest-boundary
 * exemptions). Three
 * rules conflict with repo invariants and are NOT registered:
 * - no-conditional-empty-object-spread: conflicts with exactOptionalPropertyTypes
 * - no-unknown-parameters: conflicts with boundary validator pattern
 * - no-reflect-get: conflicts with Reflect.get for class instances
 * no-shape-in-symbol-names was dropped in #1149 and is NOT registered: a
 * substring ban cannot tell the credential `shape` field from the DayShape
 * domain (see docs/reference/code-style.md).
 * require-safety-comment-for-type-assertion was removed outright: all 281 of
 * its violations lived under the test/eval exemption, so it never fired on a
 * product file — the `SAFETY:` convention it asked for lives on as review
 * judgment in docs/reference/code-style.md instead of as a rule.
 */
const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "require-readable-spacing": requireReadableSpacingRule,
  },
});

export default antiSlopPlugin;
