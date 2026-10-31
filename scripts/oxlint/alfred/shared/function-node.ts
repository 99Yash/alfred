import type { ESTree } from "@oxlint/plugins";

/** A function body boundary: a declaration, an expression, or an arrow. */
export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

/** True for a node that opens a new function scope. A walk up the tree stops here. */
export function isFunctionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}
