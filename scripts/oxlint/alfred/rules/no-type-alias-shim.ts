import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { importOf, resolveName } from "../shared/module-bindings.ts";
import { inGateScopeExcept } from "../shared/scope.ts";

/**
 * `no-type-alias-shim`: an exported type that is only a new name for an
 * imported type. `import type { Foo } from "./reader"; export type Bar = Foo`
 * adds a name without adding a fact, so two names answer for one shape. An
 * alias earns its place only when it states a fact (a deprecation, an
 * invariant, an ownership boundary) in the doc comment above it, and such a
 * file joins OWNERS with that reason.
 *
 * What it flags. A module-level type alias whose right-hand side is a bare
 * type reference: a name or a dotted path (`M.Thing`) with no type arguments.
 * The first segment of the reference must resolve, through the scope manager,
 * to an import: named, renamed (`{ Foo as Row }`), default or namespace, from
 * any module, above or below the alias. It also flags:
 * - an alias of a module-level alias that is itself such a rename
 *   (`type Row = Foo; export type Bar = Row`), at any depth;
 * - an empty interface that extends one such type and nothing else
 *   (`export interface Bar extends Foo {}`), the same rename spelt as an
 *   interface;
 * - an alias or interface that the module exports by name later
 *   (`type Bar = Foo; export type { Bar }`), not only `export type Bar = …`.
 *
 * Not a rename. A derivation states a fact, so it is not reported:
 * `Pick<Foo, "id">`, `z.infer<typeof schema>`, `(typeof list)[number]`,
 * `typeof x`, `Foo[]`, `Foo | null`, an interface that adds a member. An alias
 * of a type that the file itself defines is not an import shim (a deprecated
 * second name for a local type, for example). A type alias that the module
 * does not export is private to the file, so it is not a second door.
 *
 * Out of reach. A renamed re-export (`export type { Foo as Bar } from
 * "./reader"`) is a re-export, which `alfred/no-type-re-export-shim` reads for
 * `constants` modules only.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), minus OWNERS.
 */

/** Sanctioned renames. Each one carries a doc comment at the alias that names its fact. */
const OWNERS: ReadonlySet<string> = new Set([
  // ActiveEntity* rows are pinned to the active run.
  "packages/assistant/src/knowledge/reader.ts",
  // ParkWake is a signal wake plus a persisted deadline.
  "packages/assistant/src/execution/sub-agent-join.ts",
  // CallKind is api_call_log.kind, owned by @alfred/contracts.
  "packages/ai/src/metering/metered.ts",
  // The catalog owns the provider key space.
  "packages/assistant/src/connections/mcp/built-ins.ts",
  // The sidebar and the header share one actions shape.
  "apps/web/src/lib/shell/app-sidebar/types.ts",
]);

type Declaration = ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration;

/** The first segment of `Foo`, `M.Thing` or `M.a.Thing`. */
function firstSegment(name: ESTree.Node): ESTree.Node {
  let current = name;

  while (current.type === "TSQualifiedName") current = current.left;

  while (current.type === "MemberExpression") current = current.object;

  return current;
}

/** The module-level alias or interface that declares `variable`, or null. */
function localDeclarationOf(variable: Variable): Declaration | null {
  if (variable.scope.type !== "module") return null;

  for (const definition of variable.defs) {
    const node = definition.node;

    if (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") {
      return node;
    }
  }

  return null;
}

/**
 * The reference that `declaration` renames: the right-hand side of an alias
 * when it is a bare type reference, or the one heritage of an empty interface.
 * Null when the declaration states anything more.
 */
function renamedReference(declaration: Declaration): ESTree.Node | null {
  if (declaration.type === "TSTypeAliasDeclaration") {
    const type = declaration.typeAnnotation;

    if (type.type !== "TSTypeReference" || type.typeArguments != null) return null;

    return type.typeName;
  }

  if (declaration.body.body.length !== 0 || declaration.extends.length !== 1) return null;
  const [heritage] = declaration.extends;

  if (heritage === undefined || heritage.typeArguments != null) return null;
  const expression = heritage.expression;

  return expression.type === "Identifier" || expression.type === "MemberExpression"
    ? expression
    : null;
}

/** True when `declaration` renames an import, directly or through a chain of local renames. */
function renamesImport(
  sourceCode: SourceCode,
  declaration: Declaration,
  seen: Set<Declaration>,
): boolean {
  if (seen.has(declaration)) return false;
  seen.add(declaration);
  const reference = renamedReference(declaration);

  if (reference === null) return false;
  const first = firstSegment(reference);
  const variable = resolveName(sourceCode, first);

  if (variable === null) return false;

  if (importOf(variable) !== null) return true;

  // Only a whole-name rename of a local declaration chains: `Row.x` is not a type path.
  if (first !== reference) return false;
  const local = localDeclarationOf(variable);

  return local !== null && renamesImport(sourceCode, local, seen);
}

/** True when the module exports `declaration`, by its own `export` or by name. */
function isExported(sourceCode: SourceCode, declaration: Declaration): boolean {
  const parent = declaration.parent;

  if (parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration") {
    return true;
  }

  return sourceCode.getDeclaredVariables(declaration).some((variable) =>
    variable.references.some((reference) => {
      const holder = reference.identifier.parent;

      return (
        (holder.type === "ExportSpecifier" && holder.local === reference.identifier) ||
        holder.type === "ExportDefaultDeclaration" ||
        holder.type === "TSExportAssignment"
      );
    }),
  );
}

export const noTypeAliasShimRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow exporting a bare new name for an imported type.",
    },
    messages: {
      typeAliasShim:
        "`{{name}}` is only a new name for an imported type. Do not alias an imported type with `export type X = Y` when Y is just another name for the same shape. Import Y directly, or define X in the module that owns it. An alias earns its place only when it states a fact — a deprecation, an invariant, an ownership boundary — in the doc comment above it; a bare rename is a second door.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScopeExcept(context.filename, context.cwd, OWNERS);
      },
      Program(program) {
        for (const statement of program.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ||
            statement.type === "ExportDefaultDeclaration"
              ? statement.declaration
              : statement;

          if (
            declaration === null ||
            (declaration.type !== "TSTypeAliasDeclaration" &&
              declaration.type !== "TSInterfaceDeclaration")
          ) {
            continue;
          }

          if (
            renamesImport(context.sourceCode, declaration, new Set()) &&
            isExported(context.sourceCode, declaration)
          ) {
            context.report({
              node: declaration,
              messageId: "typeAliasShim",
              data: { name: declaration.id.name },
            });
          }
        }
      },
    };
  },
});
