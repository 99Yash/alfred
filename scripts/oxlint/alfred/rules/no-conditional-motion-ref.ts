import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

/**
 * `no-conditional-motion-ref`: a `motion` element (`<m.div>`, `<motion.button>`)
 * does not take a `ref` that the render chooses.
 *
 * motion's `useMotionRef` returns one `useCallback` with deps
 * `[visualElement]`, so it reads the external ref only at mount and unmount.
 * A changed `ref` prop on a mounted `m.*` node is ignored. With
 * `ref={isPresent ? pillRef : undefined}`, the ref keeps the node it saw at
 * mount, and an outside-click test then reads the wrong node. Found in PR
 * #1481 (`selection-quote.tsx`). See
 * `.lessons/a-motion-node-reads-its-ref-once-and-a-class-delta-must-write-scale-not-transform.md`.
 * Pass one stable ref, and test a marker data attribute with `closest(…)`, or
 * sync the ref in a layout effect keyed on the condition.
 *
 * What it flags. A `ref` attribute on a JSX element whose name is a member of
 * `m` or `motion`, when its value is a `?:` or a `&&`/`||`/`??` expression.
 *
 * What it skips. A plain DOM element, which re-runs its ref when the prop
 * changes. A `ref` that is one name, a member or a call.
 *
 * What it does not see. A component made with `motion.create(…)` under another
 * name, and a ref that a variable chose before the JSX.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

const MOTION_NAMESPACES = new Set(["m", "motion"]);

function isMotionElement(name: ESTree.JSXElementName): boolean {
  return (
    name.type === "JSXMemberExpression" &&
    name.object.type === "JSXIdentifier" &&
    MOTION_NAMESPACES.has(name.object.name)
  );
}

export const noConditionalMotionRefRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject a conditional `ref` on a `motion` element, which reads its ref only at mount.",
    },
    messages: {
      conditionalRef:
        "A `motion` element reads its `ref` only at mount (`useMotionRef`), so a ref that the render chooses is ignored after mount. Pass one stable ref, and test a marker data attribute with `closest(…)`, or sync the ref in a layout effect.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      JSXOpeningElement(node) {
        if (!isMotionElement(node.name)) return;

        for (const attribute of node.attributes) {
          if (
            attribute.type !== "JSXAttribute" ||
            attribute.name.type !== "JSXIdentifier" ||
            attribute.name.name !== "ref" ||
            attribute.value?.type !== "JSXExpressionContainer"
          ) {
            continue;
          }

          const { expression } = attribute.value;

          if (
            expression.type === "ConditionalExpression" ||
            expression.type === "LogicalExpression"
          ) {
            context.report({ node: attribute, messageId: "conditionalRef" });
          }
        }
      },
    };
  },
});
