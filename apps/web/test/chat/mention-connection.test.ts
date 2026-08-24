import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyMentionValue } from "../../src/routes/-chat/mention-connection";

const connected = new Map([["google_gmail", "connected"]]);
const disconnected = new Map([["google_gmail", "available"]]);

describe("classifyMentionValue", () => {
  test("sources without an integration are internal", () => {
    assert.equal(classifyMentionValue("web", disconnected), "internal");
    assert.equal(classifyMentionValue("memory", disconnected), "internal");
    assert.equal(classifyMentionValue("notes", disconnected), "internal");
  });

  test("short aliases resolve to their catalog provider", () => {
    assert.equal(classifyMentionValue("gmail", connected), "connected");
    assert.equal(classifyMentionValue("calendar", disconnected), "connectable");
    assert.equal(classifyMentionValue("drive", disconnected), "connectable");
  });

  test("a backend provider reads connected only on an active grant", () => {
    assert.equal(classifyMentionValue("github", new Map([["github", "connected"]])), "connected");
    assert.equal(classifyMentionValue("github", new Map()), "connectable");
  });

  test("catalog-only providers with no connect flow stay unavailable", () => {
    assert.equal(classifyMentionValue("slack", connected), "unavailable");
    assert.equal(classifyMentionValue("linear", connected), "unavailable");
    assert.equal(classifyMentionValue("slack", new Map()), "unavailable");
  });

  test("an unknown value is internal, not a phantom nudge", () => {
    assert.equal(classifyMentionValue("not-a-source", disconnected), "internal");
  });
});
