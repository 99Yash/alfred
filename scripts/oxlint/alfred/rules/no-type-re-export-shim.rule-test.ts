import { RuleTester } from "oxlint/plugins-dev";

import { noTypeReExportShimRule } from "./no-type-re-export-shim.ts";

// The spec of `no-type-re-export-shim`. The cases above each "new" banner moved
// here from `scripts/consolidation-rules.selftest.mjs`, where the rule was a
// regex. Each one keeps its outcome: a must-catch fixture is an `invalid` case,
// and a must-ignore fixture is a `valid` case. The cases below the banners are
// the holes the regex left, which the AST closes.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const reExport = (name: string) => ({ messageId: "typeReExport", data: { name } });

tester.run("alfred/no-type-re-export-shim", noTypeReExportShimRule, {
  valid: [
    {
      name: "the barrel is the sanctioned re-exporter",
      filename: "packages/extraction/src/index.ts",
      code: `export type { PdfExtractionLimits } from "./constants";`,
    },
    {
      name: "the barrel may star-re-export the types of constants",
      filename: "packages/extraction/src/index.ts",
      code: `export type * from "./constants";
export type * as Limits from "./constants";`,
    },
    {
      name: "a type star re-export of a module that is not constants",
      code: `export type * from "./prompt";`,
    },
    {
      name: "a type from a module that is not constants",
      code: `export type { ChatMediaPart } from "./types";`,
    },
    {
      name: "a type imported from a module that is not constants",
      code: `import type { ChatMediaPart } from "./types";

export type { ChatMediaPart };`,
    },
    {
      name: "a local type exported above an import of constants",
      code: `export type { PdfDoor };

import type { PdfExtractionLimits } from "./constants";

type PdfDoor = { limits: PdfExtractionLimits };`,
    },
    // ---------------------------------------------------------------------
    // New must-ignore cases: look-alikes the AST tells apart.
    // ---------------------------------------------------------------------
    {
      // A value re-export is no-constants-re-export's, so each shape is
      // reported by one rule.
      name: "a value re-export is no-constants-re-export's",
      code: `import { LIMIT } from "./constants";

export { LIMIT };
export * from "./constants";
export { OTHER } from "./constants";`,
    },
    {
      name: "a type derived from a constants type is a new type",
      code: `import type { PdfExtractionLimits } from "./constants";

export type PdfDoor = { limits: PdfExtractionLimits };`,
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a type re-export in a test tree is out of scope",
      filename: "packages/extraction/test/support/limits.ts",
      code: `export type { PdfExtractionLimits } from "../../src/constants";`,
    },
  ],
  invalid: [
    {
      // The line 8281ff65 removed from `extract-pdf.ts`.
      name: "a logic file re-exporting a constants type",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `export type { PdfExtractionLimits } from "./constants";`,
      errors: [reExport("PdfExtractionLimits")],
    },
    {
      name: "the inline type modifier is the same re-export",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `export { type PdfExtractionLimits } from "./constants";`,
      errors: [reExport("PdfExtractionLimits")],
    },
    {
      // The line rule this used to be saw only one line, so the formatter's
      // split of a long specifier list hid it.
      name: "a type re-export split by the formatter",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `export type {
  PdfExtractionLimits,
  ExtractionDoor,
} from "./constants";`,
      errors: [reExport("PdfExtractionLimits"), reExport("ExtractionDoor")],
    },
    {
      name: "a constants type imported, then exported",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `import type { PdfExtractionLimits } from "./constants";
import { truncateExtractedForLimit } from "./extract-pdf-protocol";

export type { PdfExtractionLimits };`,
      errors: [reExport("PdfExtractionLimits")],
    },
    {
      name: "the type import below the export",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `export type { PdfExtractionLimits };

import type { PdfExtractionLimits } from "./constants";`,
      errors: [reExport("PdfExtractionLimits")],
    },
    {
      name: "a namespace type import of constants, exported again",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `import type * as Limits from "./constants";

export type { Limits };`,
      errors: [reExport("Limits")],
    },
    {
      name: "a logic file star-re-exporting the types of a constants module",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `export type * from "./constants";`,
      errors: [reExport("*")],
    },
    {
      name: "a logic file re-exporting constants types as a namespace",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `export type * as Limits from "../constants";`,
      errors: [reExport("Limits")],
    },
    // ---------------------------------------------------------------------
    // The holes the regex left, closed by the AST. Each case below was
    // missed by the regex rule, or reported by the value rule instead.
    // ---------------------------------------------------------------------
    {
      // The regex reported a type-only import exported with a plain
      // `export { … }` as a value re-export. Only a type crosses, so it is this
      // rule's.
      name: "a type-only import exported with a plain export list",
      code: `import type { PdfExtractionLimits } from "./constants";
import { type ExtractionDoor } from "./constants";

export { PdfExtractionLimits, ExtractionDoor };`,
      errors: [reExport("PdfExtractionLimits"), reExport("ExtractionDoor")],
    },
    {
      name: "a default type import of constants, exported again",
      code: `import type Limits from "./constants";

export type { Limits };`,
      errors: [reExport("Limits")],
    },
    {
      name: "a renamed type re-export",
      code: `export type { PdfExtractionLimits as PdfLimits } from "./constants";`,
      errors: [reExport("PdfLimits")],
    },
    {
      // The regex required the specifier to end at `constants`.
      name: "a constants module named with an extension",
      code: `export type * from "./constants.ts";`,
      errors: [reExport("*")],
    },
    {
      // The regex read a specifier list as `[^}]*`, so a `}` in a comment
      // inside the list ended it before `from`.
      name: "a brace in a comment inside the specifier list",
      code: `export type {
  /* a } in prose */ PdfExtractionLimits,
} from "./constants";`,
      errors: [reExport("PdfExtractionLimits")],
    },
    {
      // A mixed list: the inline type is this rule's, the value is
      // no-constants-re-export's.
      name: "a mixed value and type specifier list",
      code: `export { LIMIT, type Limits } from "./constants";`,
      errors: [reExport("Limits")],
    },
  ],
});
