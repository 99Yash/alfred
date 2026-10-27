import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

/**
 * `no-union-enum-without-default`: every Elysia `t.UnionEnum` call passes an
 * explicit `default`.
 *
 * `elysia/dist/type-system/index.mjs` builds
 * `{ default: values[0], ...options, ... }`, so a `t.UnionEnum` with no option
 * fills a missing field with its first member. A probe showed a decision POST
 * with no `decision` reaching the handler as `"approve"` (200): a silent
 * wrong-approval, not a validation error. With `{ default: undefined }`, a
 * missing required field fails validation and a missing optional field stays
 * missing, so the handler `??` defaults stay the one place that names them.
 *
 * What it flags. A call to `t.UnionEnum` (also `ElysiaType.UnionEnum` or a
 * bare `UnionEnum`) whose arguments hold no object literal with an explicit
 * `default` key: no second argument, a non-object second argument, an object
 * without the key, or an object whose only `default` could come from a spread
 * (`{ ...base }`). The tree cannot tell what a spread carries, so a spread
 * without an explicit `default` key alongside it is reported.
 *
 * What it skips. An options object with an explicit `default` key, including
 * alongside a spread (`{ ...base, default: undefined }`). A callee that merely
 * contains the name (`myUnionEnumerator(...)`) is not a call of it.
 *
 * Why not `t.Union` of `t.Literal` instead. A `t.Union` over a mapped owner
 * tuple (`TUPLE.map((v) => t.Literal(v))`) compiles and runs, but Elysia's
 * context inference needs a tuple argument: `.map` returns an array, and the
 * handler type collapses (an optional query field to `undefined`, a required
 * body field to `never`), which also breaks the Eden client type. Spelling
 * the tuple by hand copies the owner vocabulary, so `t.UnionEnum` with
 * `{ default: undefined }` is the form this rule keeps honest.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), like every rule
 * here, so no `overrides` entry is needed.
 */

function isUnionEnumCall(node: ESTree.CallExpression): boolean {
  const { callee } = node;

  if (callee.type === "Identifier") return callee.name === "UnionEnum";

  if (callee.type !== "MemberExpression") return false;

  const { property } = callee;

  if (!callee.computed && property.type === "Identifier") return property.name === "UnionEnum";

  return callee.computed && property.type === "Literal" && property.value === "UnionEnum";
}

function hasDefaultKey(node: ESTree.CallExpression): boolean {
  if (node.arguments.length < 2) return false;

  const options = node.arguments[1];

  if (options.type !== "ObjectExpression") return false;

  for (const property of options.properties) {
    if (property.type === "SpreadElement") continue;

    const { key } = property;

    if (!property.computed && key.type === "Identifier" && key.name === "default") return true;

    if (key.type === "Literal" && key.value === "default") return true;
  }

  return false;
}

export const noUnionEnumWithoutDefaultRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Require an explicit `default` on every Elysia `t.UnionEnum` call.",
    },
    messages: {
      missingDefault:
        '`t.UnionEnum` fills a missing field with its first member (a decision POST with no `decision` arrived as `"approve"`). Pass `{ default: undefined }` so a missing required field fails validation and a missing optional field stays missing, and put the default in the handler (`??`).',
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      CallExpression(node) {
        if (!isUnionEnumCall(node)) return;

        if (!hasDefaultKey(node)) {
          context.report({ node: node.callee, messageId: "missingDefault" });
        }
      },
    };
  },
});
