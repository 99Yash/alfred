import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

/**
 * `no-swallowed-catch`: a `.catch(…)` handler does not drop the error and
 * return a constant.
 *
 * A handler such as `.catch(() => null)` makes a failure look like a real
 * empty result, and no log shows the fault. Found in PRs #1458
 * (`.catch(() => {})` on UNSUBSCRIBE) and #1122 (`.catch(() => null)` made a
 * failed read look like no chunk). See
 * `docs/reference/smells/no-swallowed-catch.md`.
 *
 * What it flags. A call `<expr>.catch(handler)` or `<expr>?.catch(handler)`
 * whose first argument is an arrow or a function expression, sync or async,
 * with one of these bodies:
 * - an empty block: `() => {}`, also with only a comment in it;
 * - a block whose only statement is `return;` or `return <constant>;`;
 * - an expression that is a constant: `() => null`.
 * A constant is a literal (`null`, `false`, `0`, `""`), `undefined`,
 * `void <constant>`, a template literal with no expression, `[]`, `{}`, or a
 * `-` or `!` of a constant. A constant body cannot read the error, so the rule
 * does not look at the parameters.
 *
 * What it skips. A handler that does anything else: a log call, a rethrow, a
 * `Promise.reject`, a branch on the error, an object with keys such as
 * `{ ok: false, reason }`, or any other call. Those are the Good forms, or a
 * form that review owns.
 *
 * What it does not see. A handler passed by name (`.catch(noop)`), the second
 * argument of `.then(ok, fail)`, a `try`/`catch` statement, a handler that
 * returns a non-empty default such as `new Map()` or `{ items: [] }`, and a
 * handler that returns a constant after other statements.
 *
 * A deliberate swallow. A best-effort cleanup or an expected failure keeps the
 * handler with `// oxlint-disable-next-line alfred/no-swallowed-catch -- <why>`.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

const CONSTANT_PREFIX_OPERATORS = new Set(["void", "-", "!"]);

function isConstant(node: ESTree.Expression): boolean {
  if (node.type === "Literal") return true;

  if (node.type === "Identifier") return node.name === "undefined";

  if (node.type === "TemplateLiteral") return node.expressions.length === 0;

  if (node.type === "ArrayExpression") return node.elements.length === 0;

  if (node.type === "ObjectExpression") return node.properties.length === 0;

  if (node.type === "ParenthesizedExpression") return isConstant(node.expression);

  return (
    node.type === "UnaryExpression" &&
    CONSTANT_PREFIX_OPERATORS.has(node.operator) &&
    isConstant(node.argument)
  );
}

function isSwallowedBody(body: ESTree.BlockStatement | ESTree.Expression): boolean {
  if (body.type !== "BlockStatement") return isConstant(body);

  if (body.body.length === 0) return true;

  if (body.body.length > 1) return false;

  const [only] = body.body;

  return only.type === "ReturnStatement" && (only.argument === null || isConstant(only.argument));
}

function isCatchCall(node: ESTree.CallExpression): boolean {
  const { callee } = node;

  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "catch"
  );
}

/** The handler of a `.catch(…)` call that drops the error and returns a constant, or `null`. */
function swallowingHandler(node: ESTree.CallExpression): ESTree.Node | null {
  if (!isCatchCall(node) || node.arguments.length === 0) return null;

  const [handler] = node.arguments;

  if (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") {
    return null;
  }

  const { body } = handler;

  return body !== null && isSwallowedBody(body) ? handler : null;
}

export const noSwallowedCatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject a `.catch(…)` handler that drops the error and returns a constant, such as `.catch(() => null)`.",
    },
    messages: {
      swallowed:
        "This `.catch` handler drops the error and returns a constant, so the fault looks like a real result and no log shows it. Log it (`logger.warn({ err }, …)`) and keep the value, return a failure value that the caller tells apart, or keep the swallow with `// oxlint-disable-next-line alfred/no-swallowed-catch -- <why the failure is expected>`.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      CallExpression(node) {
        const handler = swallowingHandler(node);

        if (handler !== null) {
          context.report({ node: handler, messageId: "swallowed" });
        }
      },
    };
  },
});
