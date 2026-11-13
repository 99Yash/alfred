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
    name: "gmail.search max_results → maxResults",
    tool: "gmail.search",
    input: { q: "from:linkedin.com", max_results: 5 },
    expect: (d) => assert.equal(d.maxResults, 5),
  },
  {
    name: "calendar.list_events time_min/time_max → timeMin/timeMax",
    tool: "calendar.list_events",
    input: { time_min: "2026-07-01T00:00:00Z", time_max: "2026-07-02T00:00:00Z" },
    expect: (d) => {
      assert.ok(d.timeMin);
      assert.ok(d.timeMax);
    },
  },
  {
    name: "drive.search_files page_token / page_size casing",
    tool: "drive.search_files",
    input: { q: "name contains 'x'", page_size: 10, page_token: "tok" },
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
  // ── real Drive-DSL guard ─────────────────────────────────────────────────
  {
    name: "drive.search_files bare term → name/fullText contains",
    tool: "drive.search_files",
    input: { q: "resume" },
    expect: (d) => assert.equal(d.q, "name contains 'resume' or fullText contains 'resume'"),
  },
  {
    name: "drive.search_files q='*' → dropped (list recent)",
    tool: "drive.search_files",
    input: { q: "*" },
    expect: (d) => assert.equal(d.q, undefined),
  },
  // ── calendar over-specification (window wins; no bounce) ─────────────────
  {
    name: "calendar.list_events kitchen-sink (bounds + window + partOfDay)",
    tool: "calendar.list_events",
    input: {
      timeMin: "2026-07-09T12:00:00+05:30",
      timeMax: "2026-07-10T12:00:00+05:30",
      window: "today",
      partOfDay: "full_day",
      maxResults: 50,
    },
    expect: (d) => assert.equal(d.window, "today"),
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
