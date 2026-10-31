import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { inGateScope } from "../shared/scope.ts";

/**
 * `no-brand-mint-outside-owner`: only the owner module of a `unique symbol`
 * brand writes a type guard or a `z.custom` schema for it.
 *
 * A `unique symbol` brand is a type tag only. Each expression of the brand
 * type mints it. An `as Brand` cast is visible in review, but two mints need
 * no cast and no disable line: a type guard `(x: unknown): x is Brand` and a
 * `z.custom<Brand>()` schema. "Validate, do not cast" pushes a writer to them.
 * So a doc that says "only `foo()` mints it" was false, and review found that
 * overclaim in #1540 and #1548. See
 * `docs/reference/smells/brand-claim-needs-probe.md`.
 *
 * What it flags, in a file that is not the owner of the brand:
 * - a type predicate, `x is T` or `asserts x is T`, in a function, an arrow, a
 *   method or a signature, where `T` names a brand anywhere in it
 *   (`x is { day: LocalDateKey }` mints the field);
 * - a `custom<T>(…)` call (`z.custom`, `zod.custom`, or a bare `custom`),
 *   where `T` names a brand.
 *
 * How a name becomes a brand. The plugin has no type information, so BRANDS
 * below is a closed table of each brand type and its owner file. A name in a
 * predicate or a `custom` type argument is a brand when an import binds it to
 * a BRANDS name (also renamed), when it is a BRANDS name with no local
 * declaration, or when it is the right side of a qualified name or an
 * `import("…").X` type. A type alias or an interface of the same file that
 * names a brand, at any depth and through other local aliases, is a brand too:
 * `type ParkWake = SafeToParkWake` carries `SafeToParkWake`.
 *
 * Table completeness. In each file, a `unique symbol` that a type declaration
 * uses as a computed key makes that declaration a brand. The rule reports such
 * a declaration when BRANDS does not list it with this file as its owner, and
 * a `unique symbol` that no declaration uses as a key. So a new or a renamed
 * brand fails lint until BRANDS names it.
 *
 * Out of reach (no type information, and no cross-file view):
 * - a type declared in another file that holds a brand field
 *   (`x is ReceiptRow`, when `ReceiptRow` has a `LocalDateKey` field);
 * - a merge into a branded value (`Object.assign(branded, { raw })`), another
 *   call's branded value, an overload signature that returns the brand, and an
 *   explicit type argument to a generic guard (`isType<Brand>(x)`);
 * - a zod `.brand<"X">()` brand, whose parse is its mint;
 * - an `as Brand` cast, which review sees.
 *
 * A guard that only narrows. A guard is not a mint of a brand that the type of
 * its narrowed parameter already names, also through a local alias:
 * `(args: Live | Passthrough): args is Passthrough`, where both shapes carry
 * `IanaTimezone`, narrows a value that is already branded. The cost is a miss:
 * `(v: string | LocalDateKey): v is LocalDateKey` mints from `string`, and the
 * rule skips it.
 *
 * Too wide. The rule does not read variance, so a brand in a function
 * parameter of the minted type counts: `x is Handler`, with
 * `type Handler = (zone: IanaTimezone) => void`, is reported. Give that guard
 * a disable comment with its reason.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), so a test may
 * build a branded fixture.
 */

/** Each `unique symbol` brand type, by name, and the repo file that owns its mints. */
const BRANDS: ReadonlyMap<string, string> = new Map([
  ["ApprovedMcpHealthExternalId", "packages/assistant/src/connections/object-state/events.ts"],
  ["BarrierRunId", "apps/web/src/lib/events/replay-state.ts"],
  ["DeliveryInstant", "packages/assistant/src/connections/object-state/delivery-instant.ts"],
  ["IanaTimezone", "packages/contracts/src/briefing.ts"],
  ["LocalDateKey", "packages/assistant/src/time/local-time.ts"],
  ["PublicAppErrorMessage", "packages/contracts/src/app-errors/index.ts"],
  ["ReceiptProjection", "packages/assistant/src/connections/ingestion/receipt-document.ts"],
  ["RedactedToolInput", "packages/ai/src/metering/langfuse.ts"],
  ["SafeToParkWake", "packages/assistant/src/tool-runtime/index.ts"],
  ["SealedCredentialSecret", "packages/db/src/credential-envelope.ts"],
]);

type TypeDeclaration = ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration;

/** A name that a type references. `direct` is a qualified or `import()` name: no local lookup. */
type TypeRef = Readonly<{ name: string; direct: boolean }>;

type MintSite = Readonly<{
  node: ESTree.TSTypePredicate | ESTree.CallExpression;
  form: "type guard" | "z.custom";
  /** The names in the minted type. */
  refs: TypeRef[];
  /** The names in the type of the parameter that a guard narrows. */
  inputRefs: TypeRef[];
}>;

/** The `/`-separated repo path of the linted file, the form BRANDS names. */
function repoPath(filename: string, cwd: string): string {
  const normalized = filename.split("\\").join("/");
  const root = `${cwd.split("\\").join("/")}/`;

  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

function isUniqueSymbolType(type: ESTree.TSType | undefined): boolean {
  return (
    type?.type === "TSTypeOperator" &&
    type.operator === "unique" &&
    type.typeAnnotation.type === "TSSymbolKeyword"
  );
}

/** True for `custom<T>(…)`: `z.custom`, `zod.custom`, or a bare imported `custom`. */
function isCustomCallee(callee: ESTree.Expression): boolean {
  if (callee.type === "Identifier") return callee.name === "custom";

  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "custom"
  );
}

/** The name a type reference reads, or null for `this`. */
function referenceOf(typeName: ESTree.TSTypeName): TypeRef | null {
  if (typeName.type === "Identifier") return { name: typeName.name, direct: false };

  if (typeName.type === "TSQualifiedName") return { name: typeName.right.name, direct: true };

  return null;
}

/** The type alias or interface that holds `node`, or null at module level. */
function enclosingDeclaration(node: ESTree.Node): TypeDeclaration | null {
  let current: ESTree.Node | null | undefined = node.parent;

  while (current) {
    if (current.type === "TSTypeAliasDeclaration" || current.type === "TSInterfaceDeclaration") {
      return current;
    }

    current = current.parent;
  }

  return null;
}

/**
 * The type predicate that narrows `param`, when `param` is a parameter of a
 * function or a signature whose return type is `param is T`.
 */
function predicateOn(param: ESTree.Node): ESTree.TSTypePredicate | null {
  if (param.type !== "Identifier") return null;
  const fn = param.parent;

  if (!("params" in fn) || !("returnType" in fn)) return null;
  const predicate = fn.returnType?.typeAnnotation;

  if (predicate?.type !== "TSTypePredicate") return null;

  if (predicate.parameterName.type !== "Identifier") return null;

  return predicate.parameterName.name === param.name ? predicate : null;
}

type Context =
  | { kind: "mint"; site: MintSite }
  | { kind: "input"; site: MintSite }
  | { kind: "declaration"; name: string }
  | null;

export const noBrandMintOutsideOwnerRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a type guard or a `z.custom` schema of a `unique symbol` brand outside its owner module.",
    },
    messages: {
      mintOutsideOwner:
        "This {{form}} mints the brand `{{brand}}` with no cast, outside its owner `{{owner}}`. Call the owner's guard or parse function, or move this mint into the owner.",
      unlistedBrand:
        "`{{name}}` is a `unique symbol` brand that BRANDS in scripts/oxlint/alfred/rules/no-brand-mint-outside-owner.ts does not list with this file as its owner. Add it, so a mint outside this file fails lint.",
      unusedBrandSymbol:
        "No type alias or interface in this file uses `{{name}}` as a computed key, so the rule cannot name its brand. Brand a named type with it, and add that type to BRANDS.",
    },
  },
  createOnce(context) {
    let file = "";
    let uniqueSymbols = new Map<string, ESTree.Node>();
    let symbolKeyUses = new Map<string, Set<TypeDeclaration | null>>();
    let declarations = new Map<string, TypeRef[]>();
    let imports = new Map<string, string>();
    let sites: MintSite[] = [];
    let siteOf = new Map<ESTree.Node, MintSite>();

    /** The nearest mint site or type declaration around a type reference. */
    function contextOf(node: ESTree.Node): Context {
      let child: ESTree.Node = node;
      let current: ESTree.Node | null | undefined = node.parent;

      while (current) {
        if (current.type === "TSTypePredicate") {
          return { kind: "mint", site: mintSite(current, "type guard") };
        }

        if (current.type === "TSTypeAnnotation") {
          const predicate = predicateOn(current.parent);

          if (predicate !== null) return { kind: "input", site: mintSite(predicate, "type guard") };
        }

        if (
          current.type === "TSTypeParameterInstantiation" &&
          current.parent.type === "CallExpression" &&
          current.parent.typeArguments === current &&
          isCustomCallee(current.parent.callee)
        ) {
          return { kind: "mint", site: mintSite(current.parent, "z.custom") };
        }

        if (
          current.type === "TSTypeAliasDeclaration" ||
          current.type === "TSInterfaceDeclaration"
        ) {
          return child === current.id ? null : { kind: "declaration", name: current.id.name };
        }

        child = current;
        current = current.parent;
      }

      return null;
    }

    function mintSite(node: MintSite["node"], form: MintSite["form"]): MintSite {
      const existing = siteOf.get(node);

      if (existing !== undefined) return existing;
      const site: MintSite = { node, form, refs: [], inputRefs: [] };

      siteOf.set(node, site);
      sites.push(site);

      return site;
    }

    function record(node: ESTree.Node, ref: TypeRef | null): void {
      if (ref === null) return;
      const where = contextOf(node);

      if (where === null) return;

      if (where.kind === "mint") {
        where.site.refs.push(ref);

        return;
      }

      if (where.kind === "input") {
        where.site.inputRefs.push(ref);

        return;
      }

      const refs = declarations.get(where.name) ?? [];

      refs.push(ref);
      declarations.set(where.name, refs);
    }

    /** The brands a reference carries: through imports and same-file declarations. */
    function brandsOf(ref: TypeRef, seen: Set<string>): Set<string> {
      if (ref.direct) return BRANDS.has(ref.name) ? new Set([ref.name]) : new Set();

      if (BRANDS.get(ref.name) === file) return new Set([ref.name]);
      const local = declarations.get(ref.name);

      if (local !== undefined) {
        const found = new Set<string>();

        if (seen.has(ref.name)) return found;
        seen.add(ref.name);

        for (const inner of local) {
          for (const brand of brandsOf(inner, seen)) found.add(brand);
        }

        return found;
      }

      const imported = imports.get(ref.name) ?? ref.name;

      return BRANDS.has(imported) ? new Set([imported]) : new Set();
    }

    return {
      before() {
        if (!inGateScope(context.filename, context.cwd)) return false;
        file = repoPath(context.filename, context.cwd);
        uniqueSymbols = new Map();
        symbolKeyUses = new Map();
        declarations = new Map();
        imports = new Map();
        sites = [];
        siteOf = new Map();

        return true;
      },
      ImportSpecifier(node) {
        const imported =
          node.imported.type === "Identifier" ? node.imported.name : node.imported.value;

        imports.set(node.local.name, imported);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;

        if (isUniqueSymbolType(node.id.typeAnnotation?.typeAnnotation)) {
          uniqueSymbols.set(node.id.name, node);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (!declarations.has(node.id.name)) declarations.set(node.id.name, []);
      },
      TSInterfaceDeclaration(node) {
        if (!declarations.has(node.id.name)) declarations.set(node.id.name, []);
      },
      TSPropertySignature(node) {
        if (!node.computed || node.key.type !== "Identifier") return;
        const owner = enclosingDeclaration(node);
        const uses = symbolKeyUses.get(node.key.name) ?? new Set();

        uses.add(owner);
        symbolKeyUses.set(node.key.name, uses);
      },
      TSTypeReference(node) {
        record(node, referenceOf(node.typeName));
      },
      TSInterfaceHeritage(node) {
        if (node.expression.type === "Identifier") {
          record(node, { name: node.expression.name, direct: false });
        }
      },
      TSImportType(node) {
        const { qualifier } = node;

        if (qualifier === null) return;
        record(node, {
          name: qualifier.type === "Identifier" ? qualifier.name : qualifier.right.name,
          direct: true,
        });
      },
      CallExpression(node) {
        if (node.typeArguments && isCustomCallee(node.callee)) mintSite(node, "z.custom");
      },
      TSTypePredicate(node) {
        mintSite(node, "type guard");
      },
      "Program:exit"() {
        for (const [symbol, declarator] of uniqueSymbols) {
          const uses = symbolKeyUses.get(symbol);

          if (uses === undefined) {
            context.report({
              node: declarator,
              messageId: "unusedBrandSymbol",
              data: { name: symbol },
            });
            continue;
          }

          for (const declaration of uses) {
            if (declaration === null) {
              context.report({
                node: declarator,
                messageId: "unusedBrandSymbol",
                data: { name: symbol },
              });
              continue;
            }

            if (BRANDS.get(declaration.id.name) === file) continue;
            context.report({
              node: declaration.id,
              messageId: "unlistedBrand",
              data: { name: declaration.id.name },
            });
          }
        }

        for (const site of sites) {
          const brands = new Set<string>();
          const alreadyBranded = new Set<string>();

          for (const ref of site.refs) {
            for (const brand of brandsOf(ref, new Set())) brands.add(brand);
          }

          for (const ref of site.inputRefs) {
            for (const brand of brandsOf(ref, new Set())) alreadyBranded.add(brand);
          }

          for (const brand of brands) {
            const owner = BRANDS.get(brand);

            if (owner === undefined || owner === file || alreadyBranded.has(brand)) continue;
            context.report({
              node: site.node,
              messageId: "mintOutsideOwner",
              data: { form: site.form, brand, owner },
            });
          }
        }
      },
    };
  },
});
