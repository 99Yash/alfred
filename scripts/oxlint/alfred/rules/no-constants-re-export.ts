import { defineRule } from "@oxlint/plugins";

import { constantsReExports } from "../shared/module-bindings.ts";
import { inGateScopeExcept } from "../shared/scope.ts";

/**
 * `no-constants-re-export`: the single-owner rule for module constants. A
 * `constants` module owns the fact, and the package barrel (`index.ts`) is the
 * only sanctioned re-exporter. A logic file that hands out a constant again
 * opens a second door: two modules answer the same fact, and nothing makes
 * them agree.
 *
 * What it flags. Every value re-export of a `constants` module that
 * `constantsReExports` (`shared/module-bindings.ts`) finds:
 * - `export { X } from "./constants"`, also renamed or split across lines;
 * - `export * from "./constants"` and `export * as C from "./constants"`;
 * - `export { X }`, `export { X as Y }`, `export default X` and `export = X`
 *   of a name that a constants import binds (named, renamed, default or
 *   namespace), anywhere in the file, above or below the export;
 * - the same through a module `const` alias (`const Y = X; export { Y }`,
 *   `export const Y = C.X`).
 *
 * A type-only re-export (`export type { … } from`, `export { type X }`,
 * `export type * from`, or a name a type-only import binds) is
 * `alfred/no-type-re-export-shim`'s, so each shape is reported by one rule.
 *
 * Out of reach. A module whose name is not `constants` (`./tool-constants`)
 * is not a constants module here. A copy (`export const LIMITS = { ...X }`)
 * or a property (`export const MAX = X.max`) is a new value, not the same
 * door, and is not reported.
 *
 * File scope. The consolidation gate's scope (`inGateScope`), minus the
 * barrels in OWNERS.
 */

/** The barrels that may re-export their package's constants. */
const OWNERS: ReadonlySet<string> = new Set([
  "packages/extraction/src/index.ts",
  "packages/assistant/src/chat/compaction/index.ts",
  "packages/assistant/src/chat/index.ts",
  "packages/assistant/src/connections/mcp/index.ts",
  "packages/ai/src/index.ts",
]);

export const noConstantsReExportRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow re-exporting a constants module's value from a module that is not its barrel.",
    },
    messages: {
      constantsReExport:
        "`{{name}}` re-exports a constant through a logic file. Do not re-export a constant through a logic file. Import from ./constants where you use it, or export from the barrel (index.ts) if it is a public contract. A logic file that imports then exports the same name is a second door.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return inGateScopeExcept(context.filename, context.cwd, OWNERS);
      },
      Program(program) {
        for (const reExport of constantsReExports(context.sourceCode, program)) {
          if (reExport.kind !== "value") continue;
          context.report({
            node: reExport.node,
            messageId: "constantsReExport",
            data: { name: reExport.name },
          });
        }
      },
    };
  },
});
