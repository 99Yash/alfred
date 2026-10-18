import { relative, sep } from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

import { isSkippedPath } from "../../../consolidation-rules.mjs";

/**
 * `no-function-wrapper-shim`: an exported function whose only job is to return
 * a constant or an imported name. Such a function is a second door to a value
 * that the caller can import directly. This rule was a regex in
 * `scripts/consolidation-rules.mjs` until four rounds of fixes (#1370, #1374,
 * #1375, #1377) showed that the holes left were scope, nesting, declarators
 * and read versus write. The AST and the scope manager see all four.
 *
 * The wrapper. It is narrow on purpose:
 * - a sync, non-generator `export function` whose whole body is
 *   `return <name>;` or `return <ns>.<name>;`;
 * - an `export const f = (…) => <name>` arrow, sync, with an expression body.
 *   Each declarator of the `export const` is read.
 * A return type on the function, on the arrow, or on the arrow's variable
 * (`f: () => T = () => X`) makes the wrapper "typed". Generics, parameter
 * lists and return types are read at any depth, because they are AST nodes.
 *
 * The returned name is resolved through the scope manager, not by text. The
 * rule flags the wrapper when one of these is true:
 * - an import binds the name (named, default or namespace), above or below
 *   the wrapper, typed or untyped;
 * - the body is a namespace member (`return C.X`) and a namespace import binds
 *   `C`. Only one level: `C.X.y` reads a property of the export `X`, which can
 *   be a mutable object. That is the same live read as `return X.y` over a
 *   named import, so the rule does not flag it;
 * - a module `const` binds the name, the wrapper is typed, and one of these is
 *   true: the module exports the `const` (`export const`, `export { X }`,
 *   `export default X`); its initializer is a primitive (a literal, a template,
 *   a unary or binary expression), so nothing can change it; or the module
 *   never changes the value (see "Read or change" below);
 * - the wrapper is untyped, and no module `let`/`var` and no parameter binds
 *   the name. An unresolved name, a module `const`, a function or a class all
 *   match in this form. A return type is what can narrow a module value to a
 *   read-only view, so an untyped getter over any binding that cannot be
 *   reassigned is a second door.
 * It never flags a parameter of the wrapper (a real binding, so a name in a
 * parameter's type or a destructured key does not count), and it never flags a
 * getter over a module `let`/`var`, which is a live read.
 *
 * Read or change. A typed getter over an unexported, non-primitive module
 * `const` is a live read when the module changes the value, because then the
 * return type narrows a value that changes (`getOnUserCreatedHooks():
 * readonly OnUserCreatedHook[]` over `_hooks`, which `registerOnUserCreated`
 * fills with `_hooks.push(fn)`). The rule reads every reference to the `const`
 * except its initializer and the return of an exported wrapper (so two getters
 * over one `const` do not hide each other). A reference CHANGES the value when
 * it is one of these:
 * - a write to the binding (`X = …`, `X++`);
 * - a write through a property path (`X.a = …`, `X.a.b += 1`, `X.a++`,
 *   `delete X.a`, `[X.a] = …`, `for (X.a of …)`);
 * - a method call on the value or on a property path, unless the method is
 *   on {@link READ_ONLY_METHODS} (`X.push(fn)` and `X.items.set(k, v)` change
 *   it; `X.includes(k)` does not);
 * - a position that hands the value, or any part of it, to code the rule
 *   cannot see: a call or `new` argument (`register(X)`, `use(X.batch)`), a
 *   binding or assignment (`const y = X.items`), a `return` from another
 *   function, an object or array element, a JSX attribute, an iteration
 *   (`for (const h of X)`), and every position not listed below.
 * A reference that only READS is one of these:
 * - a `typeof` query, in a type or as an expression;
 * - an operand of a unary or binary operator (`X.length > 0`, `k in X`,
 *   `!X.ready`), a template literal, a test (`if (X.a)`, `switch (X.kind)`),
 *   a `for … in` over the keys, or a bare expression statement;
 * - a shallow copy by spread into a new object or array (`{ ...X }`,
 *   `[...X]`);
 * - an `export` of the name, which makes the `const` exported (see above).
 * A comment that names the value is not a reference, so it is not a change.
 * Where a part of the value can reach other code, the rule counts a change.
 * That error can only skip a getter. The one exception is a shallow copy: the
 * copy shares the nested objects, and a nested object that other code changes
 * through the copy is not seen.
 *
 * File scope. The rule sees the files the consolidation gate gave it: tracked
 * `.ts`/`.tsx` source that {@link isSkippedPath} admits. Tests, evals, scripts
 * and generated output are out of scope, as they were for the regex.
 */

const READ_ONLY_METHODS = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "join",
  "has",
  "toString",
  "toLocaleString",
  "hasOwnProperty",
]);

/**
 * Methods that read one part of the receiver (`X.at(0)`, `X.get(key)`). The
 * part is then followed like a property read.
 */
const PART_READ_METHODS = new Set(["at", "get"]);

/** Wrappers that pass a value through unchanged. */
const PASS_THROUGH = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);

interface Wrapper {
  report: ESTree.Node;
  returned: ESTree.Expression;
  typed: boolean;
}

/** True for a repo file the consolidation gate scanned. */
function inScope(filename: string, cwd: string): boolean {
  const file = relative(cwd, filename).split(sep).join("/");

  return /\.tsx?$/.test(file) && !isSkippedPath(file);
}

function unwrap(node: ESTree.Expression): ESTree.Expression {
  let current = node;

  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }

  return current;
}

/** The argument of a body that is exactly one `return <expr>;`. */
function soleReturn(body: ESTree.FunctionBody | null): ESTree.Expression | null {
  if (body === null || body.body.length !== 1) return null;
  const [statement] = body.body;

  if (statement.type !== "ReturnStatement" || statement.argument === null) return null;

  return statement.argument;
}

/** Every exported wrapper in the module, in source order. */
function collectWrappers(program: ESTree.Program): Wrapper[] {
  const wrappers: Wrapper[] = [];

  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.declaration === null) continue;
    const declaration = statement.declaration;

    if (declaration.type === "FunctionDeclaration") {
      if (declaration.async || declaration.generator) continue;
      const returned = soleReturn(declaration.body);

      if (returned !== null) {
        wrappers.push({
          report: statement,
          returned: unwrap(returned),
          typed: declaration.returnType != null,
        });
      }

      continue;
    }

    if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") continue;

    for (const declarator of declaration.declarations) {
      const init = declarator.init === null ? null : unwrap(declarator.init);

      if (init === null || init.type !== "ArrowFunctionExpression" || init.async) continue;
      const returned = init.body;

      if (returned.type === "BlockStatement") continue;

      const variableTyped =
        declarator.id.type === "Identifier" && declarator.id.typeAnnotation != null;

      wrappers.push({
        report: declarator,
        returned: unwrap(returned),
        typed: init.returnType != null || variableTyped,
      });
    }
  }

  return wrappers;
}

function resolve(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);

  while (scope !== null) {
    const variable = scope.set.get(identifier.name);

    if (variable !== undefined) return variable;
    scope = scope.upper;
  }

  return null;
}

/** The `let`/`var`/`const`/`using` keyword of a variable binding, if it is one. */
function declarationKind(variable: Variable): string | null {
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.parent?.type === "VariableDeclaration") {
      return definition.parent.kind;
    }
  }

  return null;
}

function declarator(variable: Variable): ESTree.VariableDeclarator | null {
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
      return definition.node;
    }
  }

  return null;
}

/** True when the value of the expression is a primitive by construction. */
function isPrimitive(init: ESTree.Expression): boolean {
  const value = unwrap(init);

  if (value.type === "Literal") return !("regex" in value);

  return (
    value.type === "TemplateLiteral" ||
    value.type === "UnaryExpression" ||
    value.type === "BinaryExpression"
  );
}

/** True when the module exports the binding itself. */
function isExported(variable: Variable, binding: ESTree.VariableDeclarator): boolean {
  if (binding.parent.parent?.type === "ExportNamedDeclaration") return true;

  return variable.references.some((reference) => {
    const parent = reference.identifier.parent;

    return (
      parent.type === "ExportSpecifier" ||
      parent.type === "ExportDefaultDeclaration" ||
      parent.type === "TSExportAssignment"
    );
  });
}

/**
 * True when `node`, whose value is the `const` or a property path on it
 * (`X.a.b`), sits where the value is only read (see "Read or change" in the
 * rule comment). Every position this does not name counts as a change: a write
 * (`X.a = …`, `X.a++`, `delete X.a`, a destructuring target), a call or `new`
 * argument, a binding, a `return`, an element, an iteration.
 */
function valueOnlyRead(node: ESTree.Node): boolean {
  const parent = node.parent;

  if (parent === null) return false;

  if (PASS_THROUGH.has(parent.type)) return valueOnlyRead(parent);

  switch (parent.type) {
    case "TSTypeQuery":
    case "TSQualifiedName":
    case "BinaryExpression":
    case "TemplateLiteral":
    case "ExpressionStatement":
    case "SwitchCase":
      return true;
    case "MemberExpression":
      return parent.object !== node || valueOnlyRead(parent);
    case "UnaryExpression":
      return parent.operator !== "delete";
    case "LogicalExpression":
      return valueOnlyRead(parent);
    case "ConditionalExpression":
      return parent.test === node || valueOnlyRead(parent);
    case "SpreadElement":
      return parent.parent.type === "ObjectExpression" || parent.parent.type === "ArrayExpression";
    case "IfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
      return parent.test === node;
    case "SwitchStatement":
      return parent.discriminant === node;
    case "ForInStatement":
      return parent.right === node;
    case "CallExpression":
      if (parent.callee !== node) return false;

      return node.type !== "MemberExpression" || methodOnlyReads(node, parent);
    default:
      return false;
  }
}

/**
 * True when a call of `callee` (`X.includes(k)`, `X.items.get(k)`) cannot
 * change its receiver and does not hand a part of it on.
 */
function methodOnlyReads(callee: ESTree.MemberExpression, call: ESTree.CallExpression): boolean {
  if (callee.computed || callee.property.type !== "Identifier") return false;
  const method = callee.property.name;

  if (READ_ONLY_METHODS.has(method)) return true;

  return PART_READ_METHODS.has(method) && valueOnlyRead(call);
}

/** True when some reference other than `getterReturns` can change the value. */
function moduleChanges(variable: Variable, getterReturns: Set<ESTree.Node>): boolean {
  return variable.references.some((reference) => {
    if (reference.init || getterReturns.has(reference.identifier)) return false;

    if (reference.isWrite()) return true;

    return !valueOnlyRead(reference.identifier);
  });
}

function isNamespaceImport(variable: Variable | null): boolean {
  return (
    variable?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" && definition.node.type === "ImportNamespaceSpecifier",
    ) ?? false
  );
}

function flagsName(
  sourceCode: SourceCode,
  wrapper: Wrapper,
  name: ESTree.IdentifierReference,
  getterReturns: Set<ESTree.Node>,
): boolean {
  const variable = resolve(sourceCode, name);

  if (variable === null || variable.defs.length === 0) return !wrapper.typed;
  const kinds = new Set(variable.defs.map((definition) => definition.type));

  if (kinds.has("Parameter")) return false;

  if (kinds.has("ImportBinding")) return true;
  const kind = declarationKind(variable);

  if (kind === "let" || kind === "var" || kind === "using" || kind === "await using") return false;

  if (!wrapper.typed) return true;
  const binding = declarator(variable);

  if (kind !== "const" || binding === null || variable.scope.type !== "module") return false;

  if (isExported(variable, binding)) return true;

  if (binding.init === null) return false;

  return isPrimitive(binding.init) || !moduleChanges(variable, getterReturns);
}

export const noFunctionWrapperShimRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow an exported function whose only job is to return a constant or an imported name.",
    },
    messages: {
      wrapperShim:
        "Do not wrap a constant in a function that only returns it. Export the constant or import it directly. A forwarding function is a second door.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inScope(context.filename, context.cwd);
      },
      Program(program) {
        const wrappers = collectWrappers(program);

        const getterReturns = new Set<ESTree.Node>(
          wrappers.map((wrapper) => wrapper.returned).filter((node) => node.type === "Identifier"),
        );

        for (const wrapper of wrappers) {
          const returned = wrapper.returned;

          let flagged = false;

          if (returned.type === "Identifier") {
            flagged = flagsName(context.sourceCode, wrapper, returned, getterReturns);
          } else if (
            returned.type === "MemberExpression" &&
            !returned.computed &&
            !returned.optional &&
            returned.object.type === "Identifier" &&
            returned.property.type === "Identifier"
          ) {
            flagged = isNamespaceImport(resolve(context.sourceCode, returned.object));
          }

          if (flagged) context.report({ node: wrapper.report, messageId: "wrapperShim" });
        }
      },
    };
  },
});
