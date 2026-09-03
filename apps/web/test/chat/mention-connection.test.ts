import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { IntegrationStatus } from "../../src/lib/integrations/integrations";
import { classifyMentionValue } from "../../src/routes/-chat/mention-connection";

/** Typed constructor: a misspelled status is a compile error, not a drift. */
function statuses(
  ...entries: ReadonlyArray<readonly [string, IntegrationStatus]>
): ReadonlyMap<string, IntegrationStatus> {
  return new Map(entries);
}

const connected = statuses(["gmail", "connected"]);
const disconnected = statuses(["gmail", "available"]);

describe("classifyMentionValue", () => {
  test("sources without an integration are internal", () => {
    assert.equal(classifyMentionValue("web", disconnected), "internal");
    assert.equal(classifyMentionValue("memory", disconnected), "internal");
    assert.equal(classifyMentionValue("notes", disconnected), "internal");
  });

  test("a catalog slug reads its own status", () => {
    assert.equal(classifyMentionValue("gmail", connected), "connected");
    assert.equal(classifyMentionValue("calendar", disconnected), "connectable");
    assert.equal(classifyMentionValue("drive", disconnected), "connectable");
  });

  test("a backend provider reads connected only on an active grant", () => {
    assert.equal(classifyMentionValue("github", statuses(["github", "connected"])), "connected");
    assert.equal(classifyMentionValue("github", statuses()), "connectable");
  });

  test("planned providers with no connect flow stay unavailable", () => {
    assert.equal(classifyMentionValue("slack", connected), "unavailable");
    assert.equal(classifyMentionValue("linear", connected), "unavailable");
    assert.equal(classifyMentionValue("slack", statuses()), "unavailable");
  });

  test("an unknown value is internal, not a phantom nudge", () => {
    assert.equal(classifyMentionValue("not-a-source", disconnected), "internal");
  });
});
