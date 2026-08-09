import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { splitAddressList } from "@alfred/assistant/triage/gmail-sender-adapter";

// splitAddressList relocated from memory/team-graph to the Gmail sender adapter
// (campaign item 04). These cases are the ones that lived in team-graph.test.ts.
describe("splitAddressList", () => {
  test("splits a plain comma-separated list", () => {
    assert.deepEqual(splitAddressList("a@x.com, b@y.com,c@z.com"), [
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  test("does not split on a comma inside a quoted display name", () => {
    assert.deepEqual(splitAddressList('"Doe, Jane" <jane@x.com>, bob@y.com'), [
      '"Doe, Jane" <jane@x.com>',
      "bob@y.com",
    ]);
  });

  test("does not split on a comma inside angle brackets", () => {
    assert.deepEqual(splitAddressList("Team <team@x.com>, Ann <ann@y.com>"), [
      "Team <team@x.com>",
      "Ann <ann@y.com>",
    ]);
  });

  test("empty / null → []", () => {
    assert.deepEqual(splitAddressList(null), []);
    assert.deepEqual(splitAddressList("   "), []);
  });
});
