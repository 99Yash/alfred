import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { classRootVisitor, individualTransformProperty } from "../shared/class-tokens.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `transition-names-individual-transform`: an arbitrary transition list that
 * names `transform` also names each individual transform property that the
 * same element's classes write.
 *
 * Tailwind v4 `scale-*`, `translate-*` and `rotate-*` write the CSS `scale`,
 * `translate` and `rotate` properties, not `transform`
 * (`tailwindcss/dist/lib.js`). A list such as `transition-[color,transform]`
 * does not name those properties, so an `active:scale-[0.96]` press or a
 * `data-[state=open]:rotate-90` chevron snaps with no ease. The delta classes
 * `app-press` (`scale`) and `app-hover-lift` (`translate`) in
 * `apps/web/src/index.css` write the individual properties too, so they count.
 * The fix names the property: `transition-[color,scale]`. Keep `transform` in
 * the list only when an inline `style.transform`, a `motion` node, or a
 * `rotate-x/y/z-*` or `skew-*` utility on the element still needs it.
 *
 * What it flags. A `transition-[…]` token whose list holds `transform`, on an
 * element whose class tokens (any variant) write `scale`, `translate` or
 * `rotate`, when the list does not name that property. It reports once for
 * each list, and names the missing properties.
 *
 * What it skips. `transition-transform` and `transition`, which already
 * include the individual properties in v4. A list without `transform`: the
 * author did not ask for a transform ease. A list that names each property
 * that the element writes.
 *
 * What it does not see. One element's classes are read through
 * `shared/class-tokens.ts`, so a class from another module or from a
 * `className` prop is out of its reach.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

const DELTA_CLASS_PROPERTIES = new Map([
  ["app-press", "scale"],
  ["app-hover-lift", "translate"],
]);

/** The properties of an arbitrary transition list, or null for another token. */
function transitionList(utility: string): string[] | null {
  const match = /^transition-\[(.+)\]$/.exec(utility);

  return match === null ? null : match[1].split(",").map((entry) => entry.trim());
}

export const transitionNamesIndividualTransformRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a `transition-[…transform…]` list to name the `scale`, `translate` or `rotate` property that the element writes.",
    },
    messages: {
      missingProperty:
        "This list names `transform`, but Tailwind v4 `scale-*`/`translate-*`/`rotate-*` (and `app-press`/`app-hover-lift`) write the `{{missing}}` property, so the change snaps. Name `{{missing}}` in the list. Keep `transform` only when an inline transform or a `motion` node needs it.",
    },
  },
  createOnce(context) {
    let reported = new Set<ESTree.Node>();

    const visitor = classRootVisitor(
      () => context.sourceCode,
      (tokens) => {
        const written = new Set<string>();

        for (const token of tokens) {
          const property =
            individualTransformProperty(token.utility) ??
            (token.variants.length === 0 ? DELTA_CLASS_PROPERTIES.get(token.utility) : undefined);

          if (property !== undefined) written.add(property);
        }

        if (written.size === 0) return;

        for (const token of tokens) {
          const list = transitionList(token.utility);

          if (list === null || !list.includes("transform") || reported.has(token.node)) continue;

          const missing = [...written].filter((property) => !list.includes(property)).toSorted();

          if (missing.length === 0) continue;

          reported.add(token.node);
          context.report({
            node: token.node,
            messageId: "missingProperty",
            data: { missing: missing.join("`, `") },
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
