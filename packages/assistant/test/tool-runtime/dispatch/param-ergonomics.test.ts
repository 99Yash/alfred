import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TOOL_INPUT_SCHEMAS } from "@alfred/contracts/tool-schemas";
import { normalizeToolInputKeys } from "../../../src/tool-runtime/internal/dispatch/normalize-keys";

/**
 * Param shapes the model really sends, which the strict schemas used to reject.
 * Each must validate on the first try through the dispatcher's two steps:
 * `normalizeToolInputKeys`, then `schema.safeParse`.
 */

type InputSchemaToolName = keyof typeof TOOL_INPUT_SCHEMAS;

function dispatchParse(toolName: InputSchemaToolName, input: unknown) {
  const schema = TOOL_INPUT_SCHEMAS[toolName];
  assert.ok(schema, `no schema registered for ${toolName}`);
  const normalized = normalizeToolInputKeys(input, schema);

  return schema.safeParse(normalized.input);
}

interface Case {
  readonly name: string;
  readonly tool: InputSchemaToolName;
  readonly input: Record<string, unknown>;
  readonly expect?: (data: Record<string, unknown>) => void;
}

const CASES: readonly Case[] = [
  // ── casing family (general normalizer) ──────────────────────────────────
  {
    name: "sheets.append_values spreadsheet_id/value_input_option → camelCase",
    tool: "sheets.append_values",
    input: {
      spreadsheet_id: "sheet_1",
      range: "Sheet1!A1",
      values: [["a"]],
      value_input_option: "RAW",
    },
    expect: (d) => {
      assert.equal(d.spreadsheetId, "sheet_1");
      assert.equal(d.valueInputOption, "RAW");
    },
  },
  {
    name: "contacts.list page_token / page_size casing",
    tool: "contacts.list",
    input: { page_size: 10, page_token: "tok" },
    expect: (d) => {
      assert.equal(d.pageSize, 10);
      assert.equal(d.pageToken, "tok");
    },
  },
];

describe("param-ergonomics: measured fumbles validate first-try through dispatch", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const parsed = dispatchParse(c.tool, c.input);
      assert.equal(
        parsed.success,
        true,
        parsed.success ? "" : `bounced: ${JSON.stringify(parsed.error.issues)}`,
      );

      if (c.expect) c.expect(parsed.data);
    });
  }
});
