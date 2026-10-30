import { defineRule } from "@oxlint/plugins";

import { classRootVisitor } from "../shared/class-tokens.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `motion-safe-variant-animate`: on an element that turns its animation off
 * with `motion-reduce:animate-none`, each variant-prefixed `animate-*` utility
 * also carries `motion-safe:`.
 *
 * `data-[state=open]:animate-[…]` has an attribute selector, so its specificity
 * is higher than `motion-reduce:animate-none`. The `@media` query does not add
 * specificity, so the open animation wins and a user who asks for reduced
 * motion still sees it. Found in PR #1475 (`attachment-lightbox.tsx`). The fix
 * gates the animation itself: `motion-safe:data-[state=open]:animate-[…]`.
 *
 * What it flags. On one element (`shared/class-tokens.ts`) that holds
 * `motion-reduce:animate-none`: an `animate-*` utility other than
 * `animate-none` with at least one variant, none of them `motion-safe` or
 * `motion-reduce`.
 *
 * What it skips. An `animate-*` utility with no variant: a plain utility
 * sorts before the `motion-reduce` variant and has the same specificity, so
 * `animate-none` wins. An element with no `motion-reduce:animate-none`.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

const MOTION_VARIANTS = new Set(["motion-safe", "motion-reduce"]);

export const motionSafeVariantAnimateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `motion-safe:` on a variant-prefixed `animate-*` utility on an element that has `motion-reduce:animate-none`.",
    },
    messages: {
      variantBeatsReduce:
        "`{{token}}` has a higher specificity than `motion-reduce:animate-none`, so it still animates for a user who asks for reduced motion. Prefix it with `motion-safe:`.",
    },
  },
  createOnce(context) {
    // A `const` class string can reach two roots (its own and a `cn(base, …)` that reads it).
    let reported = new Set<string>();

    const visitor = classRootVisitor(
      () => context.sourceCode,
      (tokens) => {
        const reduces = tokens.some(
          (token) => token.utility === "animate-none" && token.variants.includes("motion-reduce"),
        );

        if (!reduces) return;

        for (const token of tokens) {
          const key = `${token.node.start}:${token.raw}`;

          if (
            !token.utility.startsWith("animate-") ||
            token.utility === "animate-none" ||
            token.variants.length === 0 ||
            token.variants.some((variant) => MOTION_VARIANTS.has(variant)) ||
            reported.has(key)
          ) {
            continue;
          }

          reported.add(key);
          context.report({
            node: token.node,
            messageId: "variantBeatsReduce",
            data: { token: token.raw },
          });
        }
      },
    );

    return {
      before() {
        reported = new Set();

        return inGateScope(context.filename, context.cwd);
      },
      ...visitor,
    };
  },
});
