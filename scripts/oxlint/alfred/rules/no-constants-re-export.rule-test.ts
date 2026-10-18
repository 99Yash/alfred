import { RuleTester } from "oxlint/plugins-dev";

import { noConstantsReExportRule } from "./no-constants-re-export.ts";

// The spec of `no-constants-re-export`. The cases above each "new" banner moved
// here from `scripts/consolidation-rules.selftest.mjs`, where the rule was a
// regex. Each one keeps its outcome: a must-catch fixture is an `invalid` case,
// and a must-ignore fixture is a `valid` case. The cases below the banners are
// the holes the regex left, which the AST closes.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const reExport = (name: string) => ({ messageId: "constantsReExport", data: { name } });

tester.run("alfred/no-constants-re-export", noConstantsReExportRule, {
  valid: [
    {
      name: "the ai package root barrel star-re-exports its constants",
      filename: "packages/ai/src/index.ts",
      code: `export * from "./embeddings";
export * from "./constants";`,
    },
    {
      name: "a star re-export of a module that is not constants",
      code: `export * from "./prompt";`,
    },
    {
      name: "the barrel may re-export a namespace of constants",
      filename: "packages/extraction/src/index.ts",
      code: `import * as constants from "./constants";

export { constants };`,
    },
    {
      name: "the barrel is the sanctioned re-exporter",
      filename: "packages/extraction/src/index.ts",
      code: `import { REALTIME_PDF_EXTRACTION_LIMITS } from "./constants";
export { REALTIME_PDF_EXTRACTION_LIMITS };`,
    },
    {
      name: "the chat barrel re-exports a compaction constant",
      filename: "packages/assistant/src/chat/index.ts",
      code: `export { CHAT_MAX_OUTPUT_TOKENS } from "./compaction/constants";`,
    },
    {
      name: "the mcp barrel re-exports its constants",
      filename: "packages/assistant/src/connections/mcp/index.ts",
      code: `export {
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  McpRawClient,
  type McpCallEnvelope,
} from "./client";

export { RAILWAY_MCP_ENDPOINT_HREF, RAILWAY_MCP_STORED_ISSUER } from "./constants";`,
    },
    {
      name: "importing a constant to use it is the intended form",
      code: `import { CHAT_MAX_OUTPUT_TOKENS } from "./compaction/constants";

const reserve = CHAT_MAX_OUTPUT_TOKENS * 2;

export { reserve };`,
    },
    {
      name: "a local name exported above an import of a constant",
      code: `export { reserve };

import { CHAT_MAX_OUTPUT_TOKENS } from "./compaction/constants";

const reserve = CHAT_MAX_OUTPUT_TOKENS * 2;`,
    },
    {
      name: "a namespace from a module that is not constants",
      code: `import * as prompt from "./prompt";

export { prompt };`,
    },
    {
      name: "re-exporting a name from a module that is not constants",
      code: `import { buildPrompt } from "./prompt";

export { buildPrompt };`,
    },
    // ---------------------------------------------------------------------
    // New must-ignore cases: look-alikes the AST tells apart.
    // ---------------------------------------------------------------------
    {
      // The regex read an import inside a string as an import, and blanked only
      // whole comment lines, so this template flagged the local `LIMIT`.
      name: "an import spelt inside a string is not an import",
      code: `const example = 'import { LIMIT } from "./constants";';
const LIMIT = 3;

export { example, LIMIT };`,
    },
    {
      name: "a type-only re-export is no-type-re-export-shim's",
      code: `import type { PdfExtractionLimits } from "./constants";
import { type TextLimits } from "./constants";

export type { OfficeLimits } from "./constants";
export type * as Limits from "./constants";
export { type ExtractionDoor } from "./constants";
export type { PdfExtractionLimits };
export { TextLimits };`,
    },
    {
      // A copy and a property are new values, not the same door.
      name: "a spread copy and a property of a constant are new values",
      code: `import { LIMITS } from "./constants";

export const OVERRIDES = { ...LIMITS, max: 4 };
export const MAX = LIMITS.max;`,
    },
    {
      // A `let` can be reassigned, so its value is not the constant's.
      name: "a module let that starts as a constant",
      code: `import { LIMIT } from "./constants";

let current = LIMIT;

export function raise() {
  current += 1;
}

export { current };`,
    },
    {
      name: "a sibling module whose name only ends in -constants",
      code: `export * from "./tool-constants";
export { BRIEFING_SLOTS } from "@alfred/contracts/briefing-constants";`,
    },
    {
      // Node's built-in `constants` module has no "/", so it is not a constants module.
      name: "the Node built-in constants module",
      code: `import { O_RDONLY } from "constants";

export { O_RDONLY };`,
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a re-export in a test tree is out of scope",
      filename: "packages/assistant/test/support/limits.ts",
      code: `export * from "../../src/constants";`,
    },
  ],
  invalid: [
    {
      // The two-line shim 8281ff65 removed from `chat-request-pressure.ts`.
      name: "a logic file importing then exporting a constant",
      filename: "packages/assistant/src/chat/compaction/chat-request-pressure.ts",
      code: `import {
  CHAT_HYDRATED_IMAGE_TOKENS,
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_SYNC_COMPACTION_RATIO,
} from "./constants";

export { CHAT_HYDRATED_IMAGE_TOKENS, CHAT_MAX_OUTPUT_TOKENS };`,
      errors: [reExport("CHAT_HYDRATED_IMAGE_TOKENS"), reExport("CHAT_MAX_OUTPUT_TOKENS")],
    },
    {
      name: "the same shim through a parent constants module",
      filename: "packages/assistant/src/action-policies/resolve.ts",
      code: `import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "../constants";
export { DEFAULT_APPROVAL_NOTIFY_DELAY_MS };`,
      errors: [reExport("DEFAULT_APPROVAL_NOTIFY_DELAY_MS")],
    },
    {
      // The `extract-pdf.ts` head 8281ff65 removed. The type re-export in it is
      // `alfred/no-type-re-export-shim`'s, so this rule reports the value only.
      name: "statements between the import and the export",
      filename: "packages/extraction/src/extract-pdf.ts",
      code: `import { REALTIME_PDF_EXTRACTION_LIMITS } from "./constants";
import type { PdfExtractionLimits } from "./constants";

export type { PdfExtractionLimits } from "./constants";
export { REALTIME_PDF_EXTRACTION_LIMITS };`,
      errors: [reExport("REALTIME_PDF_EXTRACTION_LIMITS")],
    },
    {
      name: "a value re-export from constants, split by the formatter",
      code: `export {
  EMBEDDING_DIMENSIONS,
  VOYAGE_MAX_BATCH_INPUTS,
} from "./constants";`,
      errors: [reExport("EMBEDDING_DIMENSIONS"), reExport("VOYAGE_MAX_BATCH_INPUTS")],
    },
    {
      // TypeScript hoists imports, so an import below its re-export is the same shim.
      name: "the import below the export",
      filename: "packages/assistant/src/action-policies/resolve.ts",
      code: `export { DEFAULT_APPROVAL_NOTIFY_DELAY_MS };

import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "../constants";`,
      errors: [reExport("DEFAULT_APPROVAL_NOTIFY_DELAY_MS")],
    },
    {
      name: "a default import of constants, exported again",
      code: `import LIMITS from "./constants";

export { LIMITS };`,
      errors: [reExport("LIMITS")],
    },
    {
      name: "a namespace import of constants, exported again",
      code: `import * as constants from "./constants";

export { constants };`,
      errors: [reExport("constants")],
    },
    {
      name: "a named import after a default, exported again",
      code: `import LIMITS, { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "./constants";

export { DEFAULT_APPROVAL_NOTIFY_DELAY_MS };`,
      errors: [reExport("DEFAULT_APPROVAL_NOTIFY_DELAY_MS")],
    },
    {
      name: "a logic file star-re-exporting a constants module",
      code: `export * from "./constants";`,
      errors: [reExport("*")],
    },
    {
      name: "a logic file re-exporting a constants module as a namespace",
      code: `export * as LIMITS from "../constants";`,
      errors: [reExport("LIMITS")],
    },
    // ---------------------------------------------------------------------
    // The holes the regex left, closed by the AST. Each case below was
    // missed by the regex rule.
    // ---------------------------------------------------------------------
    {
      // The regex related `export { … }` to an import only by name, so a
      // module `const` alias of the import hid it.
      name: "a module const alias of a constant, exported by name",
      code: `import { LIMIT } from "./constants";

const MAX_ITEMS = LIMIT;

export { MAX_ITEMS };`,
      errors: [reExport("MAX_ITEMS")],
    },
    {
      name: "an exported const that is a constant under a new name",
      code: `import { LIMIT } from "./constants";

export const MAX_ITEMS: number = LIMIT;`,
      errors: [reExport("MAX_ITEMS")],
    },
    {
      name: "an exported const that is a namespace member of constants",
      code: `import * as C from "./constants";

export const MAX_ITEMS = C.LIMIT satisfies number;`,
      errors: [reExport("MAX_ITEMS")],
    },
    {
      name: "a chain of module const aliases",
      code: `import { LIMIT } from "./constants";

const a = LIMIT;
const b = a;

export { b as MAX_ITEMS };`,
      errors: [reExport("MAX_ITEMS")],
    },
    {
      name: "a default export of a constant",
      code: `import { LIMITS } from "./constants";

export default LIMITS;`,
      errors: [reExport("default")],
    },
    {
      // The regex required the specifier to end at `constants`, so a file
      // extension or an explicit index hid the module.
      name: "a constants module named with an extension or an index",
      code: `export { LIMIT } from "./constants.ts";
export * from "../constants/index";`,
      errors: [reExport("LIMIT"), reExport("*")],
    },
    {
      // The regex read a specifier list as `[^}]*`, so a `}` in a comment
      // inside the list ended it early.
      name: "a brace in a comment inside the specifier list",
      code: `import { LIMIT } from "./constants";

export {
  /* a } in prose */ LIMIT,
};`,
      errors: [reExport("LIMIT")],
    },
    {
      // Kept from the regex rule, which did catch these: a renamed import and
      // a renamed export are the same door.
      name: "a renamed import or a renamed export of a constant",
      code: `import { LIMIT as MAX, OTHER } from "./constants";

export { MAX, OTHER as RENAMED };`,
      errors: [reExport("MAX"), reExport("RENAMED")],
    },
    {
      // A mixed list: the value is this rule's, the inline type is
      // no-type-re-export-shim's, so this rule reports one name.
      name: "a mixed value and type specifier list",
      code: `export { LIMIT, type Limits } from "./constants";`,
      errors: [reExport("LIMIT")],
    },
  ],
});
