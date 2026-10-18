import { defineRule } from "@oxlint/plugins";

import { constantsReExports } from "../shared/module-bindings.ts";
import { inGateScopeExcept } from "../shared/scope.ts";

/**
 * `no-type-re-export-shim`: `alfred/no-constants-re-export` for types. A
 * logic file that hands out a type of a `constants` module again opens the
 * same second door. Only the barrel (`index.ts`) may re-export a constants
 * type.
 *
 * What it flags. Every type-only re-export of a `constants` module that
 * `constantsReExports` (`shared/module-bindings.ts`) finds:
 * - `export type { Foo } from "./constants"` and the inline modifier
 *   `export { type Foo } from "./constants"`, also split across lines;
 * - `export type * from "./constants"` and `export type * as C from
 *   "./constants"`, which hand out every type at once;
 * - `export type { Foo }` or `export { type Foo }` of a name that a constants
 *   import binds, and `export { Foo }` of a name that a type-only import
 *   (`import type`, `import { type Foo }`) binds, anywhere in the file.
 *
 * A value re-export is `alfred/no-constants-re-export`'s, so each shape is
 * reported by one rule. A local alias of a constants type that the module
 * exports (`type Bar = Foo; export type { Bar }`) is a rename, which
 * `alfred/no-type-alias-shim` reports.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), minus the
 * barrels in OWNERS.
 */

/** The barrels that may re-export their package's constants types. */
const OWNERS: ReadonlySet<string> = new Set([
  "packages/extraction/src/index.ts",
  "packages/assistant/src/chat/compaction/index.ts",
]);

export const noTypeReExportShimRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow re-exporting a constants module's type from a module that is not its barrel.",
    },
    messages: {
      typeReExport:
        "`{{name}}` re-exports a constants type through a logic file. Do not re-export a type through a logic file. Import it from ./constants where you use it. Only the barrel (index.ts) may re-export a constants type.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScopeExcept(context.filename, context.cwd, OWNERS);
      },
      Program(program) {
        for (const reExport of constantsReExports(context.sourceCode, program)) {
          if (reExport.kind !== "type") continue;
          context.report({
            node: reExport.node,
            messageId: "typeReExport",
            data: { name: reExport.name },
          });
        }
      },
    };
  },
});
