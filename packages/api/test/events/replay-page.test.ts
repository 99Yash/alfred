import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { REPLAY_PAGE_SIZE, toReplayPage } from "../../src/modules/events/replay-page";

describe("event replay pages", () => {
  test("marks a full page for reconnect without dropping its last frame", () => {
    const rows = Array.from({ length: REPLAY_PAGE_SIZE + 1 }, (_, index) => ({ id: index + 1 }));
    const page = toReplayPage(rows);

    assert.equal(page.frames.length, REPLAY_PAGE_SIZE);
    assert.equal(page.frames.at(-1)?.id, REPLAY_PAGE_SIZE);
    assert.equal(page.hasMore, true);
  });

  test("keeps the connection open when the watermark fits in one page", () => {
    const rows = Array.from({ length: REPLAY_PAGE_SIZE }, (_, index) => ({ id: index + 1 }));
    const page = toReplayPage(rows);

    assert.equal(page.frames.length, REPLAY_PAGE_SIZE);
    assert.equal(page.hasMore, false);
  });
});
