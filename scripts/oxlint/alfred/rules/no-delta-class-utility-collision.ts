import { defineRule } from "@oxlint/plugins";

import { classRootVisitor, individualTransformProperty } from "../shared/class-tokens.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `no-delta-class-utility-collision`: an element with a delta class does not
 * also carry a Tailwind utility that writes the same property.
 *
 * `.app-press:active` writes `scale` and `.app-hover-lift:hover` writes
 * `translate` (`apps/web/src/index.css`). Both sit in `@layer components`.
 * Tailwind v4 utilities sit in a later layer, so a same-element `scale-*` or
 * `translate-*` utility wins at any specificity. A mouse press is also a hover,
 * so `hover:scale-[1.04]` on an `app-press` element removes the press with no
 * error. The fix gates the utility off the press: `hover:not-active:scale-[1.04]`.
 * An `app-hover-lift` element takes no `translate-*` utility.
 *
 * What it flags. On one element (`shared/class-tokens.ts`):
 * - `app-press` and a `scale-*` utility whose variants do not hold `not-active`;
 * - `app-hover-lift` and any `translate-*` utility.
 *
 * What it skips. A delta class behind a variant (`md:app-press`), which this
 * tree does not use. A `scale-*` utility gated with `not-active`.
 *
 * What it does not see. A class that a caller passes through a `className`
 * prop to a primitive that carries `app-press` (`components/ui/v2`,
 * `FrostButton`). Review keeps that part (`docs/reference/review-checklist.md`).
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

export const noDeltaClassUtilityCollisionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject a `scale-*` utility on an `app-press` element without `not-active:`, and a `translate-*` utility on an `app-hover-lift` element.",
    },
    messages: {
      pressCollision:
        "`app-press` writes `scale` in `@layer components`, and this utility writes `scale` in a later layer, so it wins and the press stops with no error. Gate it off the press with `not-active:` (for example `hover:not-active:scale-[1.04]`).",
      liftCollision:
        "`app-hover-lift` writes `translate` in `@layer components`, and this utility writes `translate` in a later layer, so it wins and the lift stops with no error. Remove the utility, or remove `app-hover-lift`.",
    },
  },
  createOnce(context) {
    // A `const` class string can reach two roots (its own and a `cn(base, …)` that reads it).
    let reported = new Set<string>();

    const visitor = classRootVisitor(
      () => context.sourceCode,
      (tokens) => {
        const deltas = new Set(
          tokens.filter((token) => token.variants.length === 0).map((token) => token.utility),
        );

        const press = deltas.has("app-press");
        const lift = deltas.has("app-hover-lift");

        if (!press && !lift) return;

        for (const token of tokens) {
          const property = individualTransformProperty(token.utility);
          const pressHit = press && property === "scale" && !token.variants.includes("not-active");
          const liftHit = lift && property === "translate";
          const key = `${token.node.start}:${token.raw}`;

          if ((!pressHit && !liftHit) || reported.has(key)) continue;

          reported.add(key);
          context.report({
            node: token.node,
            messageId: pressHit ? "pressCollision" : "liftCollision",
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
