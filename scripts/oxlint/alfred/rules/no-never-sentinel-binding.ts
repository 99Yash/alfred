import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isFunctionNode } from "../shared/function-node.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `no-never-sentinel-binding`: a `switch` clause does not declare a variable
 * with a `never` annotation.
 *
 * The old exhaustive default was `const _exhaustive: never = value;`. A `never`
 * value is assignable to each type, so the code after it compiled whatever it
 * did with the binding: `return _exhaustive`, `Boolean(_exhaustive)`,
 * `{ statusText: _exhaustive }`. At runtime a value from a newer peer or an old
 * row reaches the `default`, and the function returns the raw input as a valid
 * result. Found in PRs #1566, #1547, #701, #676 and #1219. See
 * `docs/reference/smells/never-sentinel-escape.md`.
 *
 * The binding adds no check. `typescript/switch-exhaustiveness-check` keeps its
 * defaults, so it reports a missing union member when a `default` exists. So
 * the rule reports the binding itself, not only the forms that leak it: a
 * `default` throws with `assertNever(value, what)`, or it returns a real value
 * of the return type.
 *
 * What it flags. A variable declarator whose identifier has a `never` type
 * annotation, anywhere inside a `switch` case or `default` clause, also in a
 * nested block. A function inside the clause starts a new scope, so a binding
 * there is not reported.
 *
 * What it does not see. A `never` binding before the `switch`, or one whose
 * type is an alias of `never`.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

function inSwitchClause(node: ESTree.Node): boolean {
  let current: ESTree.Node | null | undefined = node.parent;

  while (current) {
    if (current.type === "SwitchCase") return true;

    if (isFunctionNode(current)) return false;
    current = current.parent;
  }

  return false;
}

export const noNeverSentinelBindingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject a `never` binding in a `switch` clause; close the switch with `assertNever`.",
    },
    messages: {
      neverBinding:
        "A `never` binding compiles for any use, so a runtime value that reaches this clause can leak out as a valid result. Use `return assertNever(value, what)` from `@alfred/contracts`, or return a real value of the return type. `typescript/switch-exhaustiveness-check` still reports a missing member.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      VariableDeclarator(node) {
        const { id } = node;

        if (
          id.type !== "Identifier" ||
          id.typeAnnotation?.typeAnnotation.type !== "TSNeverKeyword"
        ) {
          return;
        }

        if (inSwitchClause(node)) context.report({ node: id, messageId: "neverBinding" });
      },
    };
  },
});
