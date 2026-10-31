import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

/**
 * `required-executor-param`: a transaction parameter is required. The caller
 * chooses between its own transaction and a new one.
 *
 * With `tx?: DbTransaction`, a caller that forgets the argument still
 * compiles. The write then runs on a second pooled connection, outside the
 * caller's transaction and its locks. Found in PRs #1526, #1225, #1224 and
 * #1114. See `docs/reference/smells/required-executor-param.md`.
 *
 * The Good form is `exec: DbTransaction | "own"`. A `DbTransaction` joins the
 * caller's transaction. `"own"` runs outside any caller transaction: the
 * callee opens its own transaction, or it runs one statement on the root
 * client. When each caller holds a transaction, the plain `tx: DbTransaction`
 * is the Good form.
 *
 * What it flags. The type annotation names `DbTransaction` (a type reference
 * whose last name segment is `DbTransaction`) as the whole type or as one
 * member of a union, and one of these is true:
 * - the node is optional: a parameter `tx?: …`, a property signature
 *   `tx?: …` in an interface or a type literal, or a class field `tx?: …`;
 * - the node is a parameter with a default value: `tx: … = db()`;
 * - the union also has `undefined`, on a parameter, a property signature or a
 *   class field: `exec: DbTransaction | undefined`.
 *
 * What it skips. A name in a nested position: a callback parameter type such
 * as `body?: (tx: DbTransaction) => Promise<void>` is not an executor slot,
 * and `tx?: never` names no transaction. A local variable with a
 * `DbTransaction | undefined` type is not a parameter.
 *
 * What it does not see. An oxlint JS plugin has no type information. So the
 * rule does not see an alias of the transaction type (`DbRunner`,
 * `AgentDbExecutor`, `PreferenceExecutor`, or a local alias), a type that a
 * mapped or derived type builds (`Partial<…>`, `Parameters<typeof f>[1]`), or
 * an options type that a file imports and then makes optional.
 *
 * File scope. The consolidation gate's scope (`inGateScope`).
 */

const TRANSACTION_TYPE = "DbTransaction";

function namesTransaction(type: ESTree.TSType): boolean {
  if (type.type !== "TSTypeReference") return false;

  const { typeName } = type;

  if (typeName.type === "Identifier") return typeName.name === TRANSACTION_TYPE;

  return typeName.type === "TSQualifiedName" && typeName.right.name === TRANSACTION_TYPE;
}

/** The top-level members of `type`: the members of a union, or `type` itself. */
function members(type: ESTree.TSType): ESTree.TSType[] {
  if (type.type === "TSParenthesizedType") return members(type.typeAnnotation);

  if (type.type === "TSUnionType") return type.types.flatMap(members);

  return [type];
}

type Slot = "optional" | "undefinedUnion" | "required";

/** How an annotated slot lets a caller omit the transaction, or `null` when it names none. */
function transactionSlot(
  annotation: ESTree.TSTypeAnnotation | null | undefined,
  optional: boolean,
): Slot | null {
  if (!annotation) return null;

  const types = members(annotation.typeAnnotation);

  if (!types.some(namesTransaction)) return null;

  if (optional) return "optional";

  if (types.some((type) => type.type === "TSUndefinedKeyword")) return "undefinedUnion";

  return "required";
}

/** True when `node` is in a parameter list, not a variable or a catch binding. */
function isParameter(node: ESTree.Node): boolean {
  const { parent } = node;

  if (!parent) return false;

  if (parent.type === "TSParameterProperty") return true;

  if (!("params" in parent) || !Array.isArray(parent.params)) return false;

  const params: readonly unknown[] = parent.params;

  return params.includes(node);
}

export const requiredExecutorParamRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Require a transaction parameter: `exec: DbTransaction | "own"`, not `tx?: DbTransaction`.',
    },
    messages: {
      optionalExecutor:
        'A caller that omits this transaction still compiles, and the write runs on a second pooled connection, outside its transaction and locks. Make it required: `exec: DbTransaction | "own"`, where `"own"` runs outside any caller transaction, or a plain `DbTransaction` when each caller holds one.',
    },
  },
  createOnce(context) {
    function check(
      node: ESTree.Node,
      annotation: ESTree.TSTypeAnnotation | null | undefined,
      optional: boolean,
      defaulted: boolean,
    ): void {
      const slot = transactionSlot(annotation, optional);

      if (slot === null) return;

      if (slot === "required" && !defaulted) return;

      context.report({ node, messageId: "optionalExecutor" });
    }

    return {
      before() {
        return inGateScope(context.filename, context.cwd);
      },
      Identifier(node) {
        if (!node.typeAnnotation || !isParameter(node)) return;

        // The type of `optional` claims `false`; a parameter `tx?: T` sets it to `true`.
        check(node, node.typeAnnotation, Boolean(node.optional), false);
      },
      AssignmentPattern(node) {
        const { left } = node;

        if (left.type !== "Identifier" || !isParameter(node)) return;

        check(left, left.typeAnnotation, false, true);
      },
      TSPropertySignature(node) {
        check(node, node.typeAnnotation, node.optional, false);
      },
      PropertyDefinition(node) {
        check(node, node.typeAnnotation, Boolean(node.optional), false);
      },
    };
  },
});
