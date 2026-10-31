import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral } from "../shared/class-tokens.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `switch-literal-needs-default`: a `switch` whose cases are all string
 * literals ends in a `default` clause.
 *
 * `typescript/switch-exhaustiveness-check` proves that each member of a closed
 * union has a case. It does not ask for a `default`. A stored row or a peer at
 * deploy skew can hold a member that this build does not know. Without a
 * `default`, that value matches no case, and the function returns `undefined`
 * or does nothing. Found in PRs #1535, #1132, #1103 and #868. See
 * `docs/reference/smells/switch-literal-needs-default.md`.
 *
 * What it flags. A `switch` with at least one `case`, no `default`, and a test
 * on each `case` that is a string literal or a template literal with no
 * expression. The rule reports the discriminant.
 *
 * What it skips. A switch with a `default`, whatever the `default` does. A
 * switch with a `case` test of another kind: a number, an identifier, a member
 * such as `Kind.A`, or a template literal with an expression. The repo has no
 * `enum`, so a member test is a constant of an open type, not a closed set.
 *
 * Open `string`. An oxlint JS plugin has no type information, so the rule
 * cannot tell a closed union from an open `string`. The string-literal cases
 * are the proxy. So a switch over an open `string`, such as `event.key`, with
 * no `default` is also reported. The fix there is a `default` that says what
 * happens to the other values (`default: break;` or the fallback return).
 *
 * Code after the switch. A switch that falls through to code after it, such as
 * `return null` after the last `case`, is also reported. That code is the
 * `default` in disguise: move it into a `default` clause, so the reader sees
 * the unknown-member path inside the switch.
 *
 * The `default` itself. The rule does not read it. A `default` that the
 * compiler proves unreachable calls `assertNever(value, what)` from
 * `@alfred/contracts`. A `default` that unparsed or stored-text data can reach
 * returns a real value. `alfred/no-never-sentinel-binding` rejects the old
 * `const _exhaustive: never` form.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

function isStringLiteralTest(test: ESTree.Expression): boolean {
  if (isStringLiteral(test)) return true;

  return test.type === "TemplateLiteral" && test.expressions.length === 0;
}

function needsDefault(node: ESTree.SwitchStatement): boolean {
  const { cases } = node;

  if (cases.length === 0) return false;

  return cases.every((clause) => clause.test !== null && isStringLiteralTest(clause.test));
}

export const switchLiteralNeedsDefaultRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a `default` clause on a `switch` whose `case` tests are all string literals.",
    },
    messages: {
      missingDefault:
        "A value that this build does not know (a stored row, a peer at deploy skew) matches no case and falls through. Add `default: return assertNever(value, what)` from `@alfred/contracts` when the value was parsed at its boundary, or a `default` that returns a real value when unparsed data can reach it.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      SwitchStatement(node) {
        if (needsDefault(node)) {
          context.report({ node: node.discriminant, messageId: "missingDefault" });
        }
      },
    };
  },
});
