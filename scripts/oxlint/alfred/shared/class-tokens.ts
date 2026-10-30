import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { resolveName } from "./module-bindings.ts";

/**
 * The Tailwind class tokens that one element receives, read from the syntax
 * tree. Three rules read one element's classes together:
 * `transition-names-individual-transform`, `no-delta-class-utility-collision`
 * and `motion-safe-variant-animate`. Each asks whether two tokens meet on one
 * element, so they share one answer to "which tokens are on this element".
 *
 * A class root is a `className` (or `class`) JSX attribute, or a call of a class
 * joiner (`cn`, `clsx`, `cx`, `twMerge`) that is not itself an argument of
 * another joiner. From a root the collector reads:
 * - a string literal, and each static part of a template literal;
 * - both branches of `?:`, and both sides of `&&`, `||`, `??`;
 * - the elements of an array, and the arguments of a nested joiner call;
 * - a name that a `const` in the same file binds, through its initializer
 *   (`const base = cn(…)` and then `cn(base, "active:scale-[0.96]")`).
 *
 * It does not see a class that comes from another module, a function return
 * (`triggerClassName(variant)`), a `className` prop that a caller passes, or a
 * class that the code builds with string operations. Review covers those.
 */

/** One whitespace-separated class token and the literal node that holds it. */
export type ClassToken = Readonly<{
  /** The token as written, such as `group-data-[state=open]/tools:rotate-90`. */
  raw: string;
  /** The variant chain before the utility, such as `["group-data-[state=open]/tools"]`. */
  variants: readonly string[];
  /** The utility after the variants, with a leading `-` and a `!` removed. */
  utility: string;
  /** The string literal or template element that holds the token. */
  node: ESTree.Node;
}>;

const CLASS_JOINERS = new Set(["cn", "clsx", "cx", "twMerge"]);

const CLASS_ATTRIBUTES = new Set(["className", "class"]);

/** True for a call of a class joiner such as `cn(…)`. */
function isClassJoinerCall(node: ESTree.Node): node is ESTree.CallExpression {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    CLASS_JOINERS.has(node.callee.name)
  );
}

/** True for a joiner call that is an argument of another joiner call (it is not a root). */
function isNestedJoinerCall(node: ESTree.CallExpression): boolean {
  const { parent } = node;

  return isClassJoinerCall(parent) && parent.arguments.some((argument) => argument === node);
}

/** The class expression of a `className`/`class` JSX attribute, or null for another attribute. */
function classAttributeValue(node: ESTree.JSXAttribute): ESTree.Node | null {
  if (node.name.type !== "JSXIdentifier" || !CLASS_ATTRIBUTES.has(node.name.name)) return null;
  const { value } = node;

  if (value === null) return null;

  if (value.type === "JSXExpressionContainer") {
    return value.expression.type === "JSXEmptyExpression" ? null : value.expression;
  }

  return value;
}

/** Split `variant:variant:utility` at each `:` that is outside `[…]` and `(…)`. */
function splitVariants(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) {
      parts.push(raw.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(raw.slice(start));

  return parts;
}

function tokensOfText(text: string, node: ESTree.Node): ClassToken[] {
  return text
    .split(/\s+/)
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const parts = splitVariants(raw);
      const last = parts.pop() ?? "";
      const utility = last.replace(/^!/, "").replace(/!$/, "").replace(/^-/, "");

      return { raw, variants: parts, utility, node };
    });
}

/** The `const` declarator that binds `variable` in any scope, or null. */
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

/** True for a string `Literal` node (not a number, boolean, null, bigint or regex). */
export function isStringLiteral(node: ESTree.Node): node is ESTree.StringLiteral {
  return node.type === "Literal" && typeof node.value === "string";
}

/** Every class token that `node` can give the element, by the reads in the module comment. */
function classTokensOf(
  sourceCode: SourceCode,
  node: ESTree.Node,
  seen: Set<Variable> = new Set(),
): ClassToken[] {
  if (isStringLiteral(node)) return tokensOfText(node.value, node);

  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the ESTree node union; only the forms below can carry a class, so every other node gives none.
  switch (node.type) {
    case "TemplateLiteral":
      return [
        ...node.quasis.flatMap((quasi) =>
          tokensOfText(quasi.value.cooked ?? quasi.value.raw, quasi),
        ),
        ...node.expressions.flatMap((expression) => classTokensOf(sourceCode, expression, seen)),
      ];
    case "ConditionalExpression":
      return [
        ...classTokensOf(sourceCode, node.consequent, seen),
        ...classTokensOf(sourceCode, node.alternate, seen),
      ];
    case "LogicalExpression":
      return [
        ...classTokensOf(sourceCode, node.left, seen),
        ...classTokensOf(sourceCode, node.right, seen),
      ];
    case "ArrayExpression":
      return node.elements.flatMap((element) =>
        element === null || element.type === "SpreadElement"
          ? []
          : classTokensOf(sourceCode, element, seen),
      );
    case "CallExpression":
      return isClassJoinerCall(node)
        ? node.arguments.flatMap((argument) =>
            argument.type === "SpreadElement" ? [] : classTokensOf(sourceCode, argument, seen),
          )
        : [];
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return classTokensOf(sourceCode, node.expression, seen);
    case "Identifier": {
      const variable = resolveName(sourceCode, node);

      if (variable === null || seen.has(variable)) return [];

      seen.add(variable);
      const declarator = constDeclaratorOf(variable);

      if (declarator === null || declarator.id.type !== "Identifier" || declarator.init === null) {
        return [];
      }

      return classTokensOf(sourceCode, declarator.init, seen);
    }

    default:
      return [];
  }
}

/**
 * The visitor that hands each class root of a file to `check` once. A root is
 * a `className`/`class` JSX attribute or an outermost joiner call outside one.
 * A joiner call directly inside a class attribute is read through that
 * attribute, so it is not a second root. `sourceCode` is a getter, because a
 * rule may read `context.sourceCode` only inside a visitor, not in `createOnce`.
 */
export function classRootVisitor(
  sourceCode: () => SourceCode,
  check: (tokens: readonly ClassToken[]) => void,
) {
  return {
    JSXAttribute(node: ESTree.JSXAttribute) {
      const value = classAttributeValue(node);

      if (value !== null) check(classTokensOf(sourceCode(), value));
    },
    CallExpression(node: ESTree.CallExpression) {
      if (!isClassJoinerCall(node) || isNestedJoinerCall(node)) return;
      const container = node.parent;

      if (
        container.type === "JSXExpressionContainer" &&
        container.parent.type === "JSXAttribute" &&
        classAttributeValue(container.parent) === node
      ) {
        return;
      }

      check(classTokensOf(sourceCode(), node));
    },
  };
}

/**
 * The CSS property that a Tailwind v4 transform utility writes, or null.
 * `scale-*` writes `scale`, `translate-*` writes `translate`, and `rotate-*`
 * writes `rotate`. `rotate-x-*`, `rotate-y-*`, `rotate-z-*` and `skew-*`
 * write `transform` (`tailwindcss/dist/lib.js`), so they return null.
 */
export function individualTransformProperty(
  utility: string,
): "scale" | "translate" | "rotate" | null {
  if (utility.startsWith("scale-")) return "scale";

  if (utility.startsWith("translate-")) return "translate";

  if (utility.startsWith("rotate-") && !/^rotate-[xyz]-/.test(utility)) return "rotate";

  return null;
}
