import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readGmailWatchState } from "../src/google/watch";

const validWatch = {
  topic: "projects/example/topics/gmail",
  expiresAt: "2026-08-01T00:00:00.000Z",
  baselineHistoryId: "123",
  installedAt: "2026-07-31T00:00:00.000Z",
};

describe("Gmail watch metadata", () => {
  test("reads the provider-owned watch slice without rejecting sibling metadata", () => {
    assert.deepEqual(readGmailWatchState({ token_type: "Bearer", watch: validWatch }), validWatch);
  });

  test("rejects incomplete or invalid stored watch state", () => {
    const { installedAt: _installedAt, ...missingInstalledAt } = validWatch;
    assert.equal(readGmailWatchState({ watch: missingInstalledAt }), null);
    assert.equal(
      readGmailWatchState({ watch: { ...validWatch, expiresAt: "not-a-timestamp" } }),
      null,
    );
  });
});
