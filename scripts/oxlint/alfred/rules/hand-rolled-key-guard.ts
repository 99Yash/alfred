import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { importOf, passThrough, resolveName } from "../shared/module-bindings.ts";
import { inGateScope } from "../shared/scope.ts";

/**
 * `hand-rolled-key-guard`: a hand-written "is this string a key of TABLE?"
 * test. `keyGuard(TABLE)` in `packages/contracts/src/guards.ts` owns that test.
 * It reads with `Object.hasOwn` and derives the predicate type from the table,
 * so a key added to the table widens the guard with no second edit.
 *
 * This rule was a regex row in `scripts/consolidation-rules.mjs` that saw only
 * `Object.hasOwn(TABLE, x)` and `Object.prototype.hasOwnProperty.call(TABLE, x)`
 * over a SCREAMING_CASE name. Its known holes were a lowercase table and the
 * `x in TABLE` form. #1516 then shipped a third form,
 * `TOOL_RISK_RANK[resolved] === undefined`, as a fail-closed guard. A plain
 * object inherits `toString`, `constructor`, `valueOf`, `hasOwnProperty` and
 * `__proto__` from `Object.prototype`, so `TABLE["toString"]` is a function and
 * `"toString" in TABLE` is `true`: both forms let those names through as keys.
 * A regex cannot tell `x in TABLE` from the word "in" in a string, and it cannot
 * tell which binding a name reads. The AST and the scope manager can.
 *
 * What it flags, when the receiver is a table (see below):
 * - `Object.hasOwn(TABLE, x)`, `Object.prototype.hasOwnProperty.call(TABLE, x)`,
 *   `TABLE.hasOwnProperty(x)`: a correct test, but a second spelling of
 *   `keyGuard`;
 * - `x in TABLE` and `Reflect.has(TABLE, x)`: true for an inherited key;
 * - `TABLE[x] === undefined` and `!== undefined` (also `void 0`),
 *   `TABLE[x] == null` and `!= null`, and `typeof TABLE[x] === "undefined"`, in
 *   either operand order and through `?.`: an inherited key reads back a
 *   function, not `undefined`.
 *
 * A table is an identifier that one of these binds:
 * - a module-level `const` whose initializer is an object literal with at
 *   least one property, read through `as`, `satisfies`, `!`, `(…)` and
 *   `Object.freeze(…)`. An empty `{}` is a mutable bag that a loop fills, not a
 *   closed table;
 * - an import, or any other `const`, whose name is SCREAMING_CASE, the name the
 *   regex row used. The rule cannot see the initializer of an import, and a
 *   lowercase `const` inside a function (`const rest = { ...value }`) is built
 *   per call, so it is a bag of keys;
 * - an unresolved SCREAMING_CASE name.
 * A `const` whose initializer is an array literal or a `new` expression
 * (`new Map(…)`, `new Set(…)`) is not a table, whatever its name. A parameter,
 * a `let`, a function and a class are never tables: a parameter is the body of
 * a guard such as `keyGuard` itself, and a `let` can change.
 *
 * What it skips. A static key (`"roots" in TABLE`, `TABLE["low"]`,
 * `TABLE[0]`): the compiler checks it, and it tests no runtime value. A value
 * read that is not a membership test (`TABLE[x] ?? fallback`, `if (TABLE[x])`,
 * `const rank = TABLE[x]`). A receiver that is not a plain identifier
 * (`def.kinds[x]`, `getTable()[x]`).
 *
 * What it does not see. A table reached through an alias (`const t = TABLE;
 * t[x] === undefined`) or a member (`REGISTRY.kinds[x]`). An imported
 * lowercase table (`eventPayloadSchemas`, `serverMutators`): without the
 * initializer, the name is the only signal. An imported SCREAMING_CASE array
 * read by a dynamic index (`WEEKDAYS[i] === undefined`) is a bounds check, not a
 * key test, but the rule cannot see the array and reports it. The tree had no
 * such site when the rule landed. Suppress one with the reason.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), so no
 * `overrides` entry is needed. The regex row's one owner,
 * `packages/contracts/src/guards.ts`, needs no exemption: `keyGuard` tests its
 * `table` parameter, and a parameter is not a table.
 */

const SCREAMING_CASE = /^[A-Z][A-Z0-9_]*$/;

/** The `const` declarator that binds `variable`, at any scope, or null. */
function constDeclaratorOf(variable: Variable): ESTree.VariableDeclarator | null {
  for (const definition of variable.defs) {
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.parent?.type === "VariableDeclaration" &&
      definition.parent.kind === "const"
    ) {
      return definition.node;
    }
  }

  return null;
}

/**
 * True when `identifier` reads a global, not a binding of the file. The scope
 * manager may give a configured global (`Object`, `undefined`) a variable with
 * no definition, so "no variable" and "no definition" both count.
 */
function isGlobal(sourceCode: SourceCode, identifier: ESTree.Node): boolean {
  const variable = resolveName(sourceCode, identifier);

  return variable === null || variable.defs.length === 0;
}

/** True for `Object.<name>` where `Object` is the global, not a local binding. */
function isGlobalObjectMember(sourceCode: SourceCode, node: ESTree.Node, name: string): boolean {
  if (node.type !== "MemberExpression" || node.computed) return false;

  const { object, property } = node;

  return (
    object.type === "Identifier" &&
    object.name === "Object" &&
    isGlobal(sourceCode, object) &&
    property.type === "Identifier" &&
    property.name === name
  );
}

/** The initializer read through the wrappers that hand on the same object. */
function unwrapInit(sourceCode: SourceCode, init: ESTree.Node): ESTree.Node {
  const value = passThrough(init);

  if (
    value.type === "CallExpression" &&
    value.arguments.length === 1 &&
    value.arguments[0].type !== "SpreadElement" &&
    isGlobalObjectMember(sourceCode, value.callee, "freeze")
  ) {
    return passThrough(value.arguments[0]);
  }

  return value;
}

/** True when `node` names a closed key table. The module doc lists the cases. */
function isTable(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const value = passThrough(node);

  if (value.type !== "Identifier") return false;

  const screaming = SCREAMING_CASE.test(value.name);
  const variable = resolveName(sourceCode, value);

  if (variable === null || variable.defs.length === 0) return screaming;

  if (importOf(variable) !== null) return screaming;

  const declarator = constDeclaratorOf(variable);

  if (declarator === null || declarator.init === null) return false;

  const init = unwrapInit(sourceCode, declarator.init);

  if (init.type === "ArrayExpression" || init.type === "NewExpression") return false;

  // A `const` inside a function is built per call (`const rest = { ...value }`),
  // so it is a bag of keys, not a table, unless its name says otherwise.
  if (init.type === "ObjectExpression" && variable.scope.type === "module") {
    return init.properties.length > 0;
  }

  return screaming;
}

/** True for a key the compiler can read: a literal, or a template with no expression. */
function isStaticKey(node: ESTree.Node): boolean {
  const value = passThrough(node);

  if (value.type === "Literal") return true;

  return value.type === "TemplateLiteral" && value.expressions.length === 0;
}

/** True for `TABLE[x]` with a dynamic key `x`, read through `?.`, `!` and `(…)`. */
function isDynamicTableRead(sourceCode: SourceCode, node: ESTree.Node): boolean {
  let value = passThrough(node);

  if (value.type === "ChainExpression") value = passThrough(value.expression);

  if (value.type !== "MemberExpression" || !value.computed) return false;

  return !isStaticKey(value.property) && isTable(sourceCode, value.object);
}

/** True for the global `undefined` or `void 0`. */
function isUndefined(sourceCode: SourceCode, node: ESTree.Node): boolean {
  const value = passThrough(node);

  if (value.type === "Identifier") {
    return value.name === "undefined" && isGlobal(sourceCode, value);
  }

  return value.type === "UnaryExpression" && value.operator === "void";
}

function isNull(node: ESTree.Node): boolean {
  const value = passThrough(node);

  return value.type === "Literal" && value.raw === "null";
}

/** True when one side of a comparison reads `TABLE[x]` and the other is its missing-key value. */
function isMissingKeyComparison(sourceCode: SourceCode, node: ESTree.BinaryExpression): boolean {
  const loose = node.operator === "==" || node.operator === "!=";
  const strict = node.operator === "===" || node.operator === "!==";

  if (!loose && !strict) return false;

  const sides: ReadonlyArray<readonly [ESTree.Node, ESTree.Node]> = [
    [node.left, node.right],
    [node.right, node.left],
  ];

  return sides.some(([read, sentinel]) => {
    const value = passThrough(read);

    if (value.type === "UnaryExpression" && value.operator === "typeof") {
      const literal = passThrough(sentinel);

      return (
        literal.type === "Literal" &&
        literal.value === "undefined" &&
        isDynamicTableRead(sourceCode, value.argument)
      );
    }

    const missing = isUndefined(sourceCode, sentinel) || (loose && isNull(sentinel));

    return missing && isDynamicTableRead(sourceCode, value);
  });
}

/** The table argument of an own-key call (`Object.hasOwn`, `hasOwnProperty`), or null. */
function ownKeyCallTable(sourceCode: SourceCode, node: ESTree.CallExpression): ESTree.Node | null {
  const { callee } = node;
  const first = node.arguments.length > 0 ? node.arguments[0] : null;

  if (callee.type !== "MemberExpression" || callee.computed) return null;

  if (callee.property.type !== "Identifier") return null;

  if (isGlobalObjectMember(sourceCode, callee, "hasOwn")) return first;

  // `TABLE.hasOwnProperty(x)`.
  if (callee.property.name === "hasOwnProperty") return callee.object;

  // `Object.prototype.hasOwnProperty.call(TABLE, x)`.
  if (callee.property.name !== "call") return null;

  const method = callee.object;

  if (method.type !== "MemberExpression" || method.computed) return null;

  if (method.property.type !== "Identifier" || method.property.name !== "hasOwnProperty") {
    return null;
  }

  return isGlobalObjectMember(sourceCode, method.object, "prototype") ? first : null;
}

/** The table argument of `Reflect.has(TABLE, x)` with a dynamic key, or null. */
function reflectHasTable(sourceCode: SourceCode, node: ESTree.CallExpression): ESTree.Node | null {
  const { callee } = node;

  if (node.arguments.length < 2) return null;

  const [table, key] = node.arguments;

  if (callee.type !== "MemberExpression" || callee.computed) return null;

  const { object, property } = callee;

  if (object.type !== "Identifier" || object.name !== "Reflect") return null;

  if (!isGlobal(sourceCode, object)) return null;

  if (property.type !== "Identifier" || property.name !== "has") return null;

  if (key.type === "SpreadElement" || isStaticKey(key)) return null;

  return table;
}

export const handRolledKeyGuardRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Test a key of a closed table with `keyGuard(TABLE)` from `@alfred/contracts`, not by hand.",
    },
    messages: {
      ownKeyCall:
        "Build the guard once with `keyGuard(TABLE)` from `@alfred/contracts`. It narrows `unknown` to the table's own string keys, reads them with `Object.hasOwn`, and derives the predicate type from the table. The table must be a closed literal (`as const` or `satisfies Record<K, V>`), the same precondition as `typedKeys`.",
      inheritedKey:
        'This test is true for an inherited key: a plain object has `toString`, `constructor` and `__proto__`, so `"toString" in TABLE` is `true` and `TABLE["toString"]` is a function. Narrow the key first with `keyGuard(TABLE)` from `@alfred/contracts`, or with the guard the vocabulary already has (`isToolRiskTier`, an `enumGuard(TUPLE)`), and then read the table. For a mutable bag of keys, use a `Map`.',
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      CallExpression(node) {
        const { sourceCode } = context;
        const ownKey = ownKeyCallTable(sourceCode, node);

        if (ownKey !== null && ownKey.type !== "SpreadElement" && isTable(sourceCode, ownKey)) {
          context.report({ node, messageId: "ownKeyCall" });

          return;
        }

        const reflected = reflectHasTable(sourceCode, node);

        if (
          reflected !== null &&
          reflected.type !== "SpreadElement" &&
          isTable(sourceCode, reflected)
        ) {
          context.report({ node, messageId: "inheritedKey" });
        }
      },
      BinaryExpression(node) {
        const { sourceCode } = context;

        if (node.operator === "in") {
          // `#field in value` is a `PrivateInExpression`, not a `BinaryExpression`.
          if (isStaticKey(node.left)) return;

          if (isTable(sourceCode, node.right)) {
            context.report({ node, messageId: "inheritedKey" });
          }

          return;
        }

        if (isMissingKeyComparison(sourceCode, node)) {
          context.report({ node, messageId: "inheritedKey" });
        }
      },
    };
  },
});
