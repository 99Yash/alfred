import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { contactsListInput, isRecord, sheetsAppendValuesInput } from "@alfred/contracts";
import { z } from "zod";
import { normalizeToolInputKeys } from "../../../src/tool-runtime/internal/dispatch/normalize-keys";

describe("normalizeToolInputKeys", () => {
  test("renames a snake_case variant to the camelCase schema key", () => {
    const { input, renamed } = normalizeToolInputKeys(
      { source: "saved", page_size: 5 },
      contactsListInput,
    );

    assert.deepEqual(input, { source: "saved", pageSize: 5 });
    assert.deepEqual(renamed, [{ from: "page_size", to: "pageSize" }]);
    assert.equal(contactsListInput.safeParse(input).success, true);
  });

  test("renames camelCase → the snake_case schema key (direction-agnostic)", () => {
    // A REST name in snake_case. The model sends camelCase.
    const { input } = normalizeToolInputKeys(
      { owner: "99Yash", repo: "alfred", pullNumber: 305 },
      z.object({ owner: z.string(), repo: z.string(), pull_number: z.number() }).strict(),
    );

    assert.deepEqual(input, { owner: "99Yash", repo: "alfred", pull_number: 305 });
  });

  test("normalizes a family of snake_case keys in one input", () => {
    const { input } = normalizeToolInputKeys(
      { spreadsheet_id: "sheet_1", range: "Sheet1!A1", values: [["a"]], value_input_option: "RAW" },
      sheetsAppendValuesInput,
    );

    assert.deepEqual(input, {
      spreadsheetId: "sheet_1",
      range: "Sheet1!A1",
      values: [["a"]],
      valueInputOption: "RAW",
    });
  });

  test("leaves an already-canonical key untouched (no spurious rename)", () => {
    const { input, renamed } = normalizeToolInputKeys(
      { source: "saved", pageSize: 5 },
      contactsListInput,
    );

    assert.deepEqual(input, { source: "saved", pageSize: 5 });
    assert.deepEqual(renamed, []);
  });

  test("does not clobber a canonical key the model already set", () => {
    // Both present is ambiguous, so strict validation decides.
    const { input, renamed } = normalizeToolInputKeys(
      { source: "saved", pageSize: 5, page_size: 99 },
      contactsListInput,
    );

    assert.ok(isRecord(input));
    assert.equal(input.pageSize, 5);
    assert.ok("page_size" in input);
    assert.deepEqual(renamed, []);
  });

  test("leaves a genuine unknown key alone (no canonical match)", () => {
    const { input, renamed } = normalizeToolInputKeys(
      { source: "saved", gibberish: 1 },
      contactsListInput,
    );

    assert.deepEqual(input, { source: "saved", gibberish: 1 });
    assert.deepEqual(renamed, []);
  });

  test("returns non-record input unchanged", () => {
    assert.deepEqual(normalizeToolInputKeys("nope", contactsListInput), {
      input: "nope",
      renamed: [],
    });
    assert.deepEqual(normalizeToolInputKeys(null, contactsListInput), { input: null, renamed: [] });
  });

  test("a schema with no object properties is a no-op", () => {
    const { input, renamed } = normalizeToolInputKeys({ a: 1 }, z.string());
    assert.deepEqual(input, { a: 1 });
    assert.deepEqual(renamed, []);
  });

  test("does not mutate the caller's input object", () => {
    const original = { source: "saved", page_size: 5 };
    normalizeToolInputKeys(original, contactsListInput);
    assert.deepEqual(original, { source: "saved", page_size: 5 });
  });
});
