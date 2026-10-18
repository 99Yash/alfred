import { RuleTester } from "oxlint/plugins-dev";

import { noTypeAliasShimRule } from "./no-type-alias-shim.ts";

// The spec of `no-type-alias-shim`. The cases above each "new" banner moved here
// from `scripts/consolidation-rules.selftest.mjs`, where the rule was a regex.
// Each one keeps its outcome: a must-catch fixture is an `invalid` case, and a
// must-ignore fixture is a `valid` case. The cases below the banners are the
// holes the regex left, which the AST closes.
//
// `pnpm check:oxlint-plugin` runs this file, and it drives every `invalid` case
// without a `filename` through the root `.oxlintrc.json`.

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const alias = (name: string) => ({ messageId: "typeAliasShim", data: { name } });

tester.run("alfred/no-type-alias-shim", noTypeAliasShimRule, {
  valid: [
    {
      name: "a derivation over a namespace member is not a rename",
      code: `import type * as reader from "./reader";

export type ConversationHeader = Pick<reader.ConversationRow, "id" | "title">;`,
    },
    {
      name: "a derivation adds a fact and is not a rename",
      code: `import type { ConversationRow } from "./reader";

export type ConversationHeader = Pick<ConversationRow, "id" | "title">;`,
    },
    {
      name: "a sanctioned rename that documents its fact",
      filename: "packages/assistant/src/execution/sub-agent-join.ts",
      code: `import type { SafeToParkWake } from "@alfred/assistant/tool-runtime";

/** A signal wake plus a persisted deadline. */
export type ParkWake = SafeToParkWake;`,
    },
    {
      // `contracts/src/chat.ts` aliases its own `TurnStartResponse` for a
      // deprecation. The rule reads only an imported name, so it needs no owner.
      name: "a rename of a type the file defines is not an import shim",
      code: `import { z } from "zod";

export type TurnStartResponse = z.infer<typeof turnStartResponseSchema>;

/** @deprecated Use \`TurnStartResponse\`. */
export type TurnKickResponse = TurnStartResponse;`,
    },
    // ---------------------------------------------------------------------
    // New must-ignore cases: derivations and look-alikes the AST tells apart.
    // ---------------------------------------------------------------------
    {
      name: "derivations over an imported type state a fact",
      code: `import type { ConversationRow, Item } from "./reader";
import { items, schema } from "./reader";
import { z } from "zod";

export type Rows = ConversationRow[];
export type MaybeRow = ConversationRow | null;
export type Parsed = z.infer<typeof schema>;
export type One = (typeof items)[number];
export type ItemShape = typeof items;
export type Boxed = Item<string>;`,
    },
    {
      name: "an interface that adds a member or takes type arguments",
      code: `import type { ConversationRow } from "./reader";

export interface Conversation extends ConversationRow {
  readonly pinned: boolean;
}

export interface ConversationHeader extends Pick<ConversationRow, "id"> {}`,
    },
    {
      // A private alias is not a second door: no other file can import it.
      name: "an alias the module does not export",
      code: `import type { ConversationRow } from "./reader";

type Row = ConversationRow;

export function title(row: Row): string {
  return row.title;
}`,
    },
    {
      // The regex read an import inside a string as an import.
      name: "an import spelt inside a string is not an import",
      code: `const example = 'import type { Row } from "./reader";';

type Row = { id: string };

export type Line = Row;
export { example };`,
    },
    {
      // The type parameter binds the name inside the alias, not the import.
      name: "a type parameter that shadows an imported name",
      code: `import type { Row } from "./reader";

export type Identity<Row> = Row;
export type Use = { row: Row };`,
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "an alias in a test tree is out of scope",
      filename: "packages/assistant/test/support/rows.ts",
      code: `import type { ConversationRow } from "../../src/reader";

export type Row = ConversationRow;`,
    },
  ],
  invalid: [
    {
      name: "an imported type renamed with no new fact",
      code: `import type { ConversationRow } from "./reader";

export type ActiveConversation = ConversationRow;`,
      errors: [alias("ActiveConversation")],
    },
    {
      // The adjacency regex this rule used to be saw only an alias directly
      // after the last import. One statement between them hid it.
      name: "statements between the import and the alias",
      code: `import type { ConversationRow } from "./reader";
import { z } from "zod";

const titleSchema = z.string();

export type ActiveConversation = ConversationRow;`,
      errors: [alias("ActiveConversation")],
    },
    {
      name: "a renamed import is still a rename",
      code: `import { type ConversationRow as Row } from "./reader";

export type ActiveConversation = Row;`,
      errors: [alias("ActiveConversation")],
    },
    {
      // TypeScript hoists imports, so an import below its alias is the same shim.
      name: "the import below the alias",
      code: `export type ActiveConversation = ConversationRow;

import type { ConversationRow } from "./reader";`,
      errors: [alias("ActiveConversation")],
    },
    {
      name: "a default import renamed",
      code: `import type ConversationRow from "./reader";

export type ActiveConversation = ConversationRow;`,
      errors: [alias("ActiveConversation")],
    },
    {
      name: "a namespace member renamed",
      code: `import type * as reader from "./reader";

export type ActiveConversation = reader.ConversationRow;`,
      errors: [alias("ActiveConversation")],
    },
    // ---------------------------------------------------------------------
    // The holes the regex left, closed by the AST. Each case below was
    // missed by the regex rule.
    // ---------------------------------------------------------------------
    {
      // The regex read only `export type X = …`, so an alias exported by name
      // later hid it.
      name: "a private alias exported by name later",
      code: `import type { ConversationRow } from "./reader";

type ActiveConversation = ConversationRow;

export type { ActiveConversation };`,
      errors: [alias("ActiveConversation")],
    },
    {
      // The regex related the right-hand side to an import only by name, so a
      // local alias in between hid it.
      name: "a rename of a private rename of an import",
      code: `import type { ConversationRow } from "./reader";

type Row = ConversationRow;

export type ActiveConversation = Row;`,
      errors: [alias("ActiveConversation")],
    },
    {
      // The regex read only `type`, so the same rename spelt as an empty
      // interface was not seen.
      name: "an empty interface that only extends an imported type",
      code: `import type { ConversationRow } from "./reader";

export interface ActiveConversation extends ConversationRow {}`,
      errors: [alias("ActiveConversation")],
    },
    {
      // The regex required a `;` after the right-hand side, so a statement
      // that ends at a newline, or with a comment before the `;`, hid it.
      name: "an alias with no semicolon or a comment before it",
      code: `import type { ConversationRow } from "./reader";

export type ActiveConversation = ConversationRow /* the row */;
export type PinnedConversation = ConversationRow
export const pinned = true;`,
      errors: [alias("ActiveConversation"), alias("PinnedConversation")],
    },
    {
      name: "a deep namespace path renamed",
      code: `import type * as db from "./schema";

export type ActiveConversation = db.tables.ConversationRow;`,
      errors: [alias("ActiveConversation")],
    },
  ],
});
