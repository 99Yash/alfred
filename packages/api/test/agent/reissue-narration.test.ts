import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { DispatchResult } from "../../src/modules/dispatch";
import {
  closeLeadInNarration,
  dispatchRoundReissued,
} from "../../src/modules/agent/workflows/chat-turn";

// The helpers only read `.kind`, so a minimal typed literal is enough to
// exercise the reissue-detection branch without a live registry/dispatch.
const result = (kind: DispatchResult["kind"]): DispatchResult => ({ kind }) as DispatchResult;

describe("dispatchRoundReissued", () => {
  test("true when the round auto-activated a tool via an inactive-tool bounce", () => {
    assert.equal(dispatchRoundReissued([result("executed"), result("inactive_tool")]), true);
  });

  test("false when every call executed", () => {
    assert.equal(dispatchRoundReissued([result("executed"), result("executed")]), false);
  });

  test("other non-execution rejections do not mark a reissue turn", () => {
    // Only `inactive_tool` makes a fresh schema available and asks for a
    // reissue; the rest self-correct without auto-activating anything.
    assert.equal(dispatchRoundReissued([result("invalid_input")]), false);
    assert.equal(dispatchRoundReissued([result("unknown_tool")]), false);
    assert.equal(dispatchRoundReissued([result("not_allowed")]), false);
  });

  test("empty or undefined slots are safe", () => {
    assert.equal(dispatchRoundReissued([]), false);
    assert.equal(dispatchRoundReissued([undefined, result("executed")]), false);
  });
});

describe("closeLeadInNarration", () => {
  test("a normal lead-in moves onto the trail and advances the segment", () => {
    const closed = closeLeadInNarration({
      narration: [{ index: 0, text: "Checking your calendar." }],
      assistantText: "Now searching your mail.",
      segmentIndex: 1,
      reissuePending: false,
    });
    assert.deepEqual(closed.narration, [
      { index: 0, text: "Checking your calendar." },
      { index: 1, text: "Now searching your mail." },
    ]);
    assert.equal(closed.assistantText, "");
    assert.equal(closed.segmentIndex, 2);
  });

  test("a reissue lead-in is dropped but the segment still advances", () => {
    // The withheld text ("tools warming up, retrying") must not reach the trail,
    // yet the index must advance so the reissued tool cards stay aligned.
    const closed = closeLeadInNarration({
      narration: [{ index: 0, text: "Pulling everything in at once." }],
      assistantText: "Tools are warming up — retrying all now.",
      segmentIndex: 1,
      reissuePending: true,
    });
    assert.deepEqual(closed.narration, [{ index: 0, text: "Pulling everything in at once." }]);
    assert.equal(closed.assistantText, "");
    assert.equal(closed.segmentIndex, 2);
  });

  test("blank lead-in text is not pushed", () => {
    const closed = closeLeadInNarration({
      narration: [],
      assistantText: "   ",
      segmentIndex: 0,
      reissuePending: false,
    });
    assert.deepEqual(closed.narration, []);
    assert.equal(closed.segmentIndex, 1);
  });
});
