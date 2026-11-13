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
  // ── synonyms (withKeyAliases) ────────────────────────────────────────────
  {
    name: "gmail.send_draft body → bodyText",
    tool: "gmail.send_draft",
    input: { to: ["a@example.com"], subject: "Hi", body: "The message body." },
    expect: (d) => assert.equal(d.bodyText, "The message body."),
  },
  {
    name: "gmail.send_draft Body (cased alias) → bodyText",
    tool: "gmail.send_draft",
    input: { to: ["a@example.com"], subject: "Hi", Body: "The message body." },
    expect: (d) => assert.equal(d.bodyText, "The message body."),
  },
  // ── scalar → array (wrapScalarRecipients, #363) ──────────────────────────
  {
    name: "gmail.send_draft bare-string to → [to]",
    tool: "gmail.send_draft",
    input: { to: "a@example.com", subject: "Hi", bodyText: "Body." },
    expect: (d) => assert.deepEqual(d.to, ["a@example.com"]),
  },
  {
    name: "gmail.send_draft bare-string cc/bcc → arrays",
    tool: "gmail.send_draft",
    input: {
      to: ["a@example.com"],
      cc: "c@example.com",
      bcc: "d@example.com",
      subject: "Hi",
      bodyText: "Body.",
    },
    expect: (d) => {
      assert.deepEqual(d.cc, ["c@example.com"]);
      assert.deepEqual(d.bcc, ["d@example.com"]);
    },
  },
  {
    name: "gmail.send_draft bare-string to + body synonym (compound #363)",
    tool: "gmail.send_draft",
    input: { to: "a@example.com", subject: "Hi", body: "Body." },
    expect: (d) => {
      assert.deepEqual(d.to, ["a@example.com"]);
      assert.equal(d.bodyText, "Body.");
    },
  },
  {
    // coerceJsonArrayFields handles it, not the scalar wrap, so nothing double-wraps.
    name: "gmail.send_draft JSON-array-string to → array (coerceJsonArrayFields)",
    tool: "gmail.send_draft",
    input: { to: '["a@example.com","b@example.com"]', subject: "Hi", bodyText: "Body." },
    expect: (d) => assert.deepEqual(d.to, ["a@example.com", "b@example.com"]),
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

describe("param-ergonomics: the send_draft scalar recipient wrap is not a blanket accept-anything", () => {
  // The wrap fixes shape, not content. An invalid address must still fail.
  test("gmail.send_draft bare-string non-email to still bounces", () => {
    const parsed = dispatchParse("gmail.send_draft", {
      to: "not-an-email",
      subject: "Hi",
      bodyText: "Body.",
    });

    assert.equal(parsed.success, false);
  });

  // A malformed JSON array is not a recipient. Neither layer may wrap it.
  test("gmail.send_draft malformed JSON-array to still bounces", () => {
    const parsed = dispatchParse("gmail.send_draft", {
      to: '["a@example.com"',
      subject: "Hi",
      bodyText: "Body.",
    });

    assert.equal(parsed.success, false);
  });
});
