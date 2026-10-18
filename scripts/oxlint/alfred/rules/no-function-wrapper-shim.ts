import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

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
 * fills with `_hooks.push(fn)`). The rule flags such a getter only when it can
 * prove that no reference changes the value. It decides from the `const`'s
 * initializer, never from a method name. It reads every reference to the
 * `const` except its initializer and the return of an exported wrapper (so two
 * getters over one `const` do not hide each other).
 *
 * Shape. The rule follows each reference along its property path (`X.a.b`,
 * `X["a"]`, `X[0]`) through the initializer, nested at any depth, and gives
 * each step one shape:
 * - primitive: a literal other than a regex (string, number, bigint, boolean,
 *   `null`), a template literal, or a unary or binary expression. Each of these
 *   makes a primitive by construction, whatever its operands are;
 * - an object literal or an array literal, read property by property;
 * - a `Map` or a `Set`: `new Map(…)` or `new Set(…)`, where the scope manager
 *   shows that no binding in scope shadows the global constructor;
 * - unknown: everything else. A call result, an import, a shorthand or spread
 *   property, a method or function value, a missing key, a computed key that
 *   is not a literal, and an element of a `Map` or a `Set` are unknown.
 * `X.length` of an array literal and `X.size` of a `Map` or a `Set` are
 * primitive.
 *
 * A reference CHANGES the value when one of these is true:
 * - it writes the binding (`X = …`) or a property path (`X.a = …`,
 *   `X.a.b += 1`, `X.a++`, `delete X.a`, `[X.a] = …`, `for (X.a of …)`);
 * - it calls a method whose receiver is not a known built-in, or a method
 *   that is not in {@link BUILT_IN_METHODS} for that built-in (`X.push(fn)`,
 *   `X.items.set(k, v)`). A method of a user object counts, whatever its name:
 *   `X.get()` can change `X` through `this`;
 * - it calls the value or a part of it (`X()`, `(X.a ?? f)()`);
 * - it reads a property of an unknown value, or a getter of an object literal.
 *   A getter or a proxy trap can run code;
 * - it coerces a value that can run code while it coerces. The coercing
 *   positions are a template literal, a unary `+`/`-`/`~`, a binary operator
 *   other than `===`/`!==`, and a computed key (`obj[X]`). The values that
 *   cannot run code are a primitive, a `Map`, a `Set`, an object literal with
 *   no spread, no computed key, no `__proto__` and no own `valueOf`,
 *   `toString` or `toLocaleString`, and an array literal whose elements are
 *   all such values;
 * - it hands a part that is not a primitive to other code: a call or `new`
 *   argument (`register(X)`, `use(X.batch)`), a binding or assignment
 *   (`const y = X.items`), a `return` from another function, an object or
 *   array element, a JSX attribute, an `await`, and every position not listed
 *   below. A spread or a `for … of` hands each item on, so it changes the value
 *   unless each item is a primitive.
 * A reference that only READS is one of these:
 * - a path that ends at a primitive, in any position (`fetch(DEFAULTS.url)`
 *   when `url` is a string literal, `X.name.startsWith(p)`). No operation on a
 *   primitive can change the `const`, so no string method table is needed;
 * - a call of a method in {@link BUILT_IN_METHODS} on an array literal, a
 *   `Map` or a `Set` (`KINDS.includes(k)`, `X.a.items.has(k)`). A method that
 *   returns a part (`X.at(0)`, `cache.get(k)`) is followed: the result has
 *   the shape of an element, and the rule reads it as it reads a reference;
 * - a `typeof` query, in a type or as an expression, a `!` or `void`, a
 *   `===`/`!==` operand, a test (`if (X)`, `X ? a : b`), a `switch`
 *   discriminant or `case`, and a bare expression statement. None of these
 *   runs code;
 * - a coercing position (see above) over a value that cannot run code
 *   (`X.length > 0`, `` `${X.batch}` ``);
 * - `for (k in X)` or `k in X` over a known shape;
 * - a spread into an object, an array or call arguments, or a `for … of`,
 *   when each item it hands on is a primitive (`{ ...DEFAULTS }` over
 *   `{ batch: 50 }`, `for (const k of KINDS)` over `["a", "b"]`). The copy then
 *   shares nothing with the `const`;
 * - an `export` of the name, which makes the `const` exported (see above).
 * `a || b`, `a ?? b`, `c ? a : b` and the TypeScript wrappers (`as`, `!`,
 * `satisfies`) pass the value on, so the rule reads the outer expression with
 * the same shape. A comment that names the value is not a reference, so it is
 * not a change.
 *
 * Residual. A value whose shape the initializer does not show is treated as
 * changed whenever code could reach it. So the rule skips that getter, and it
 * never wrongly flags one. The cost is a missed second door: a getter over
 * `const X = createConfig()` that the module reads as `X.url` is not flagged.
 *
 * File scope. The rule sees the files the consolidation gate gave it: tracked
 * `.ts`/`.tsx` source that `isSkippedPath` admits (see `inGateScope`). Tests, evals, scripts
 * and generated output are out of scope, as they were for the regex.
 */

/** The step shape of a property path (see "Shape" in the rule comment). */
type Shape =
  | Readonly<{ kind: "primitive" }>
  | Readonly<{ kind: "object"; node: ESTree.ObjectExpression }>
  | Readonly<{ kind: "array"; node: ESTree.ArrayExpression }>
  | Readonly<{ kind: "map" }>
  | Readonly<{ kind: "set" }>
  | Readonly<{ kind: "unknown" }>;

type BuiltIn = "array" | "map" | "set";

/**
 * What a built-in method does to its receiver:
 * - `read`: it runs no user code and returns no part of the receiver;
 * - `part`: it runs no user code and returns elements of the receiver, so the
 *   result is followed with the element shape;
 * - `coerce`: it coerces each element to a string, so it reads only when no
 *   element can run code while it coerces.
 * A method that is not listed counts as a change: it mutates (`push`, `set`,
 * `sort`), or it hands elements or the receiver to a callback (`forEach`,
 * `map`, `find`), or it reads element properties (`flat`).
 */
type MethodEffect = "read" | "part" | "coerce";

const BUILT_IN_METHODS = {
  array: new Map<string, MethodEffect>([
    ["includes", "read"],
    ["indexOf", "read"],
    ["lastIndexOf", "read"],
    ["keys", "read"],
    ["at", "part"],
    ["slice", "part"],
    ["concat", "part"],
    ["toReversed", "part"],
    ["with", "part"],
    ["values", "part"],
    ["entries", "part"],
    ["join", "coerce"],
    ["toString", "coerce"],
    ["toLocaleString", "coerce"],
  ]),
  map: new Map<string, MethodEffect>([
    ["has", "read"],
    ["get", "part"],
    ["keys", "part"],
    ["values", "part"],
    ["entries", "part"],
  ]),
  set: new Map<string, MethodEffect>([
    ["has", "read"],
    ["keys", "part"],
    ["values", "part"],
    ["entries", "part"],
  ]),
} as const satisfies Readonly<Record<BuiltIn, ReadonlyMap<string, MethodEffect>>>;

/** Own keys whose function runs when an object is coerced to a primitive. */
const COERCION_HOOKS = new Set(["valueOf", "toString", "toLocaleString"]);

/** Unary operators that never coerce their operand. `delete` is a write. */
const INERT_UNARY = new Set(["!", "typeof", "void"]);

const PRIMITIVE: Shape = { kind: "primitive" };

const UNKNOWN: Shape = { kind: "unknown" };

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

/** True when `name` resolves to the global constructor, with no binding in scope that shadows it. */
function isGlobal(sourceCode: SourceCode, name: ESTree.IdentifierReference): boolean {
  const variable = resolve(sourceCode, name);

  return variable === null || variable.defs.length === 0;
}

/** The shape of an initializer or a property value (see "Shape" in the rule comment). */
function shapeOf(sourceCode: SourceCode, expression: ESTree.Expression): Shape {
  let value = unwrap(expression);

  while (value.type === "TSTypeAssertion") value = unwrap(value.expression);

  switch (value.type) {
    case "Literal":
      return "regex" in value ? UNKNOWN : PRIMITIVE;
    case "TemplateLiteral":
    case "UnaryExpression":
    case "BinaryExpression":
      return PRIMITIVE;
    case "ObjectExpression":
      return { kind: "object", node: value };
    case "ArrayExpression":
      return { kind: "array", node: value };
    case "NewExpression":
      if (value.callee.type !== "Identifier" || !isGlobal(sourceCode, value.callee)) return UNKNOWN;

      if (value.callee.name === "Map") return { kind: "map" };

      return value.callee.name === "Set" ? { kind: "set" } : UNKNOWN;
    default:
      return UNKNOWN;
  }
}

/** The name of a static key: `a` in `X.a` or `{ a: 1 }`, `"a"` or `0` as a literal. */
function staticKey(key: ESTree.Node, computed: boolean): string | null {
  if (!computed && key.type === "Identifier") return key.name;

  if (key.type === "Literal" && !("regex" in key) && key.value !== null) {
    return String(key.value);
  }

  return null;
}

function isOpaqueKey(property: ESTree.ObjectProperty): boolean {
  return property.computed || staticKey(property.key, false) === "__proto__";
}

/** The element shapes of an array literal, or null when a spread hides them. */
function elementShapes(sourceCode: SourceCode, array: ESTree.ArrayExpression): Shape[] | null {
  const shapes: Shape[] = [];

  for (const element of array.elements) {
    if (element === null) shapes.push(PRIMITIVE);
    else if (element.type === "SpreadElement") return null;
    else shapes.push(shapeOf(sourceCode, element));
  }

  return shapes;
}

/** The shape of any one element: primitive when all elements are, else unknown. */
function elementShape(sourceCode: SourceCode, shape: Shape): Shape {
  if (shape.kind !== "array") return UNKNOWN;
  const shapes = elementShapes(sourceCode, shape.node);

  return shapes?.every((element) => element.kind === "primitive") ? PRIMITIVE : UNKNOWN;
}

/**
 * The shape of `<shape>.<key>`. Null when the read itself can run code: a
 * property of an unknown value (a getter or a proxy trap), or a getter of an
 * object literal.
 */
function propertyShape(sourceCode: SourceCode, shape: Shape, key: string | null): Shape | null {
  switch (shape.kind) {
    case "primitive":
      return PRIMITIVE;
    case "unknown":
      return null;
    case "map":
    case "set":
      return key === "size" ? PRIMITIVE : UNKNOWN;
    case "array": {
      if (key === "length") return PRIMITIVE;

      if (key === null || !/^(?:0|[1-9]\d*)$/.test(key)) return UNKNOWN;
      const shapes = elementShapes(sourceCode, shape.node);

      return shapes?.[Number(key)] ?? UNKNOWN;
    }

    case "object": {
      const properties = shape.node.properties;

      if (properties.some((property) => property.type === "Property" && isOpaqueKey(property))) {
        return null;
      }

      if (key === null) {
        return properties.some(
          (property) => property.type === "Property" && property.kind !== "init",
        )
          ? null
          : UNKNOWN;
      }

      for (let index = properties.length - 1; index >= 0; index -= 1) {
        const property = properties[index];

        if (property.type === "SpreadElement") return UNKNOWN;

        if (staticKey(property.key, false) !== key) continue;

        if (property.kind !== "init") return null;

        return property.method ? UNKNOWN : shapeOf(sourceCode, property.value);
      }

      return UNKNOWN;
    }
  }
}

/** True when coercing the value to a primitive cannot run code (see the rule comment). */
function coercionSafe(sourceCode: SourceCode, shape: Shape): boolean {
  switch (shape.kind) {
    case "primitive":
    case "map":
    case "set":
      return true;
    case "unknown":
      return false;
    case "array":
      return (
        elementShapes(sourceCode, shape.node)?.every((element) =>
          coercionSafe(sourceCode, element),
        ) ?? false
      );
    case "object":
      return shape.node.properties.every(
        (property) =>
          property.type === "Property" &&
          !isOpaqueKey(property) &&
          !COERCION_HOOKS.has(staticKey(property.key, false) ?? ""),
      );
  }
}

/** True when iterating the value runs no user code and hands on only primitives. */
function itemsArePrimitive(sourceCode: SourceCode, shape: Shape): boolean {
  if (shape.kind !== "array") return false;

  return (
    elementShapes(sourceCode, shape.node)?.every((element) => element.kind === "primitive") ?? false
  );
}

/** True when `{ ...value }` runs no user code and copies only primitives. */
function ownValuesArePrimitive(sourceCode: SourceCode, shape: Shape): boolean {
  switch (shape.kind) {
    case "map":
    case "set":
      return true;
    case "array":
      return itemsArePrimitive(sourceCode, shape);
    case "object":
      return shape.node.properties.every(
        (property) =>
          property.type === "Property" &&
          !isOpaqueKey(property) &&
          property.kind === "init" &&
          !property.method &&
          shapeOf(sourceCode, property.value).kind === "primitive",
      );
    default:
      return false;
  }
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

/** The outermost node that holds `node` through pass-through wrappers only. */
function lift(node: ESTree.Node): ESTree.Node {
  let current = node;

  while (current.parent !== null && PASS_THROUGH.has(current.parent.type)) {
    current = current.parent;
  }

  return current;
}

/** True when `node` is the target of a write (`node = …`, `node++`, `delete node`, a destructuring or loop target). */
function isWriteTarget(node: ESTree.Node): boolean {
  const parent = node.parent;

  switch (parent?.type) {
    case "AssignmentExpression":
    case "AssignmentPattern":
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === node;
    case "UpdateExpression":
    case "ArrayPattern":
    case "RestElement":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "Property":
      return parent.value === node && parent.parent.type === "ObjectPattern";
    default:
      return false;
  }
}

/** The effect of calling `<shape>.<method>(…)`, or null when the call counts as a change. */
function methodEffect(shape: Shape, method: string | null): MethodEffect | null {
  if (method === null) return null;

  if (shape.kind !== "array" && shape.kind !== "map" && shape.kind !== "set") return null;

  return BUILT_IN_METHODS[shape.kind].get(method) ?? null;
}

/**
 * True when `identifier`, a reference to a `const` whose initializer has the
 * shape `initial`, only reads the value (see "Read or change" in the rule
 * comment). The walk climbs the property path one step at a time and carries
 * the shape of each step. Every position it does not name counts as a change.
 */
function referenceOnlyReads(
  sourceCode: SourceCode,
  identifier: ESTree.Node,
  initial: Shape,
): boolean {
  let node = identifier;
  let shape = initial;

  for (;;) {
    node = lift(node);

    if (isWriteTarget(node)) return false;

    if (shape.kind === "primitive") return true;
    const parent = node.parent;

    if (parent === null) return false;

    switch (parent.type) {
      case "TSTypeQuery":
      case "TSQualifiedName":
      case "ExpressionStatement":
      case "SwitchCase":
        return true;
      case "UnaryExpression":
        return INERT_UNARY.has(parent.operator) || coercionSafe(sourceCode, shape);
      case "BinaryExpression":
        if (parent.operator === "===" || parent.operator === "!==") return true;

        if (parent.operator === "in" && parent.right === node) return shape.kind !== "unknown";

        return coercionSafe(sourceCode, shape);
      case "TemplateLiteral":
        return coercionSafe(sourceCode, shape);
      case "IfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
        return parent.test === node;
      case "SwitchStatement":
        return parent.discriminant === node;
      case "ForInStatement":
        return parent.right === node && shape.kind !== "unknown";
      case "ForOfStatement":
        return parent.right === node && itemsArePrimitive(sourceCode, shape);
      case "SpreadElement":
        return parent.parent.type === "ObjectExpression"
          ? ownValuesArePrimitive(sourceCode, shape)
          : itemsArePrimitive(sourceCode, shape);
      case "ConditionalExpression":
        if (parent.test === node) return true;
        node = parent;
        continue;
      case "LogicalExpression":
        node = parent;
        continue;
      case "MemberExpression": {
        if (parent.object !== node) return coercionSafe(sourceCode, shape);

        const key =
          parent.property.type === "PrivateIdentifier"
            ? null
            : staticKey(parent.property, parent.computed);

        const callee = lift(parent);
        const call = callee.parent;

        if (call?.type === "CallExpression" && call.callee === callee) {
          const effect = methodEffect(shape, key);

          if (effect === "read") return true;

          if (effect === "coerce") return coercionSafe(sourceCode, shape);

          if (effect === null) return false;
          node = call;
          shape = elementShape(sourceCode, shape);
          continue;
        }

        const next = propertyShape(sourceCode, shape, key);

        if (next === null) return false;
        node = parent;
        shape = next;
        continue;
      }

      default:
        return false;
    }
  }
}

/** True when some reference other than `getterReturns` can change the value. */
function moduleChanges(
  sourceCode: SourceCode,
  variable: Variable,
  shape: Shape,
  getterReturns: Set<ESTree.Node>,
): boolean {
  return variable.references.some((reference) => {
    if (reference.init || getterReturns.has(reference.identifier)) return false;

    if (reference.isWrite()) return true;

    return !referenceOnlyReads(sourceCode, reference.identifier, shape);
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

  const shape = shapeOf(sourceCode, binding.init);

  return shape.kind === "primitive" || !moduleChanges(sourceCode, variable, shape, getterReturns);
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
        return inGateScope(context.filename, context.cwd);
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
