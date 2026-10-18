import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * Where a module-level name comes from, read through the scope manager. Three
 * rules use it: `no-constants-re-export` and `no-type-re-export-shim` relate an
 * exported name to an import of a `constants` module, and `no-type-alias-shim`
 * relates an alias to the import it renames. A name is resolved to its one
 * binding, so a shadowing local, a comment or a string that holds the name, and
 * statements between the import and the export do not change the answer.
 */

/** The import that binds a name: its declaration and whether it binds a type only. */
type ImportOrigin = Readonly<{
  source: string;
  /** `import type …` or an inline `type` specifier: the name is a type only. */
  typeOnly: boolean;
  namespace: boolean;
}>;

/**
 * True for a module specifier that names a `constants` module: a path whose
 * last segment is `constants` (`./constants`, `../constants`,
 * `./compaction/constants`, `@alfred/extraction/constants`), with or without a
 * file extension or a trailing `/index`. A sibling such as `./tool-constants`
 * is a different module and does not count, and neither does Node's built-in
 * `constants`, which has no `/`.
 */
function isConstantsModule(specifier: string): boolean {
  return /\/constants(?:\/index)?(?:\.[cm]?[jt]sx?)?$/.test(specifier);
}

/** The binding that `identifier` reads, from the innermost scope out. */
export function resolveName(sourceCode: SourceCode, identifier: ESTree.Node): Variable | null {
  if (identifier.type !== "Identifier") return null;
  let scope: Scope | null = sourceCode.getScope(identifier);

  while (scope !== null) {
    const variable = scope.set.get(identifier.name);

    if (variable !== undefined) return variable;
    scope = scope.upper;
  }

  return null;
}

/** The import that binds `variable`, or null when an import does not bind it. */
export function importOf(variable: Variable | null): ImportOrigin | null {
  for (const definition of variable?.defs ?? []) {
    if (definition.type !== "ImportBinding") continue;
    const specifier = definition.node;
    const declaration = definition.parent;

    if (declaration?.type !== "ImportDeclaration") continue;

    return {
      source: declaration.source.value,
      typeOnly:
        declaration.importKind === "type" ||
        (specifier.type === "ImportSpecifier" && specifier.importKind === "type"),
      namespace: specifier.type === "ImportNamespaceSpecifier",
    };
  }

  return null;
}

/** The module-level `const` declarator that binds `variable`, or null. */
function moduleConstOf(variable: Variable): ESTree.VariableDeclarator | null {
  if (variable.scope.type !== "module") return null;

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
 * The import of a `constants` module that `node` hands out unchanged, or null.
 * `node` hands out the import when it is:
 * - a name that the import binds (named, default or namespace);
 * - a member of a namespace import of the module (`C.LIMIT`). One level only:
 *   `C.LIMIT.max` reads a property of the constant, not the constant;
 * - a name that a module-level `const` binds to one of these, at any depth
 *   (`const LIMIT = C.LIMIT`). A `let` can be reassigned, so it does not count.
 *
 * Parentheses, `as`, `satisfies`, `<T>` and `!` hand on the same value, so they are
 * read through.
 */
function constantsImportOf(
  sourceCode: SourceCode,
  node: ESTree.Node,
  seen: Set<Variable> = new Set(),
): ImportOrigin | null {
  const value = passThrough(node);

  if (value.type === "MemberExpression") {
    if (value.computed || value.optional || value.object.type !== "Identifier") return null;
    const origin = importOf(resolveName(sourceCode, value.object));

    return origin !== null && origin.namespace && isConstantsModule(origin.source) ? origin : null;
  }

  const variable = resolveName(sourceCode, value);

  if (variable === null || seen.has(variable)) return null;
  seen.add(variable);
  const origin = importOf(variable);

  if (origin !== null) return isConstantsModule(origin.source) ? origin : null;
  const binding = moduleConstOf(variable);

  if (binding === null || binding.id.type !== "Identifier" || binding.init === null) return null;

  return constantsImportOf(sourceCode, binding.init, seen);
}

/** `node` read through `(…)`, `as`, `satisfies`, `<T>` and `!`, which hand on the same value. */
function passThrough(node: ESTree.Node): ESTree.Node {
  let current = node;

  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }

  return current;
}

/** One exported name that hands out a `constants` module, or the whole module. */
type ConstantsReExport = Readonly<{
  node: ESTree.Node;
  /** The exported name, or `*` for a star re-export. */
  name: string;
  /** "type" when only a type crosses: `export type`, an inline `type`, or a type-only import. */
  kind: "value" | "type";
}>;

function nameOf(node: ESTree.ModuleExportName): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

/**
 * Every place where the module hands out a binding of a `constants` module
 * again. `no-constants-re-export` reports the "value" ones and
 * `no-type-re-export-shim` the "type" ones, so the two rules split one list and
 * each shape is reported once:
 * - `export { X } from "./constants"`, also renamed or split across lines;
 * - `export * from "./constants"`, `export * as C from "./constants"`;
 * - `export { X }`, `export { X as Y }`, `export default X` and `export = X`,
 *   where X is a name that hands out a constants import (see
 *   `constantsImportOf`): imported anywhere in the file, also renamed
 *   (`import { A as X }`), or a module `const` alias of one;
 * - `export const Y = X` with the same X.
 *
 * A name is "type" when the export says so (`export type { … }`, `export {
 * type X }`, `export type * from`) or the import does (`import type`, `import {
 * type X }`), because only a type then crosses.
 */
export function constantsReExports(
  sourceCode: SourceCode,
  program: ESTree.Program,
): ConstantsReExport[] {
  const found: ConstantsReExport[] = [];

  for (const statement of program.body) {
    switch (statement.type) {
      case "ExportAllDeclaration": {
        if (!isConstantsModule(statement.source.value)) break;
        found.push({
          node: statement,
          name: statement.exported === null ? "*" : nameOf(statement.exported),
          kind: statement.exportKind === "type" ? "type" : "value",
        });
        break;
      }

      case "ExportNamedDeclaration": {
        const typeExport = statement.exportKind === "type";

        if (statement.source !== null) {
          if (!isConstantsModule(statement.source.value)) break;

          for (const specifier of statement.specifiers) {
            found.push({
              node: specifier,
              name: nameOf(specifier.exported),
              kind: typeExport || specifier.exportKind === "type" ? "type" : "value",
            });
          }

          break;
        }

        for (const specifier of statement.specifiers) {
          const origin = constantsImportOf(sourceCode, specifier.local);

          if (origin === null) continue;
          found.push({
            node: specifier,
            name: nameOf(specifier.exported),
            kind:
              typeExport || specifier.exportKind === "type" || origin.typeOnly ? "type" : "value",
          });
        }

        const declaration = statement.declaration;

        if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") break;

        for (const declarator of declaration.declarations) {
          if (declarator.id.type !== "Identifier" || declarator.init === null) continue;
          const origin = constantsImportOf(sourceCode, declarator.init);

          if (origin !== null)
            found.push({ node: declarator, name: declarator.id.name, kind: "value" });
        }

        break;
      }

      case "ExportDefaultDeclaration":
      case "TSExportAssignment": {
        const exported =
          statement.type === "ExportDefaultDeclaration"
            ? statement.declaration
            : statement.expression;

        if (exported.type !== "Identifier" && exported.type !== "MemberExpression") break;
        const origin = constantsImportOf(sourceCode, exported);

        if (origin === null) break;
        found.push({
          node: statement,
          name: "default",
          kind: origin.typeOnly ? "type" : "value",
        });
        break;
      }

      default:
        break;
    }
  }

  return found;
}
