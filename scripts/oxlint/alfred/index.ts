import { eslintCompatPlugin } from "@oxlint/plugins";

import { handRolledKeyGuardRule } from "./rules/hand-rolled-key-guard.ts";
import { logCaughtErrorUnderErrRule } from "./rules/log-caught-error-under-err.ts";
import { motionSafeVariantAnimateRule } from "./rules/motion-safe-variant-animate.ts";
import { noConditionalMotionRefRule } from "./rules/no-conditional-motion-ref.ts";
import { noConstantsReExportRule } from "./rules/no-constants-re-export.ts";
import { noDashInWebCopyRule } from "./rules/no-dash-in-web-copy.ts";
import { noDeltaClassUtilityCollisionRule } from "./rules/no-delta-class-utility-collision.ts";
import { noExportedHasherRule } from "./rules/no-exported-hasher.ts";
import { noFunctionWrapperShimRule } from "./rules/no-function-wrapper-shim.ts";
import { noNeverSentinelBindingRule } from "./rules/no-never-sentinel-binding.ts";
import { noTypeAliasShimRule } from "./rules/no-type-alias-shim.ts";
import { noTypeReExportShimRule } from "./rules/no-type-re-export-shim.ts";
import { noUnionEnumWithoutDefaultRule } from "./rules/no-union-enum-without-default.ts";
import { sha256OverJsonStringifyRule } from "./rules/sha256-over-json-stringify.ts";
import { transitionNamesIndividualTransformRule } from "./rules/transition-names-individual-transform.ts";

/**
 * Alfred's own lint rules: first-party source, unlike the vendored anti-slop
 * set beside it. ./README.md says what belongs here and how a rule is proven.
 */
const alfredPlugin = eslintCompatPlugin({
  meta: { name: "alfred" },
  rules: {
    "hand-rolled-key-guard": handRolledKeyGuardRule,
    "log-caught-error-under-err": logCaughtErrorUnderErrRule,
    "motion-safe-variant-animate": motionSafeVariantAnimateRule,
    "no-conditional-motion-ref": noConditionalMotionRefRule,
    "no-constants-re-export": noConstantsReExportRule,
    "no-dash-in-web-copy": noDashInWebCopyRule,
    "no-delta-class-utility-collision": noDeltaClassUtilityCollisionRule,
    "no-exported-hasher": noExportedHasherRule,
    "no-function-wrapper-shim": noFunctionWrapperShimRule,
    "no-never-sentinel-binding": noNeverSentinelBindingRule,
    "no-type-alias-shim": noTypeAliasShimRule,
    "no-type-re-export-shim": noTypeReExportShimRule,
    "no-union-enum-without-default": noUnionEnumWithoutDefaultRule,
    "sha256-over-json-stringify": sha256OverJsonStringifyRule,
    "transition-names-individual-transform": transitionNamesIndividualTransformRule,
  },
});

export default alfredPlugin;
