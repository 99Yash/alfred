import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  closeLeadInNarration,
  closeNarrationSegment,
} from "@alfred/assistant/chat/chat-turn-state";

describe("closeLeadInNarration", () => {
  test("a normal lead-in moves onto the trail and advances the segment", () => {
    const state = {
      narration: [{ index: 0, text: "Checking your calendar." }],
      assistantText: "Now searching your mail.",
      segmentIndex: 1,
      reissuePending: false,
    };
    closeLeadInNarration(state);
    assert.deepEqual(state.narration, [
      { index: 0, text: "Checking your calendar." },
      { index: 1, text: "Now searching your mail." },
    ]);
    assert.equal(state.assistantText, "");
    assert.equal(state.segmentIndex, 2);
  });

  test("a reissue lead-in is dropped but the segment still advances", () => {
    // The withheld text ("tools warming up, retrying") must not reach the trail,
    // yet the index must advance so the reissued tool cards stay aligned. This is
    // the `advanceWhenNothingKept: true` half of the lead-in's `NarrationClose`.
    const state = {
      narration: [{ index: 0, text: "Pulling everything in at once." }],
      assistantText: "Tools are warming up — retrying all now.",
      segmentIndex: 1,
      reissuePending: true,
    };
    closeLeadInNarration(state);
    assert.deepEqual(state.narration, [{ index: 0, text: "Pulling everything in at once." }]);
    assert.equal(state.assistantText, "");
    assert.equal(state.segmentIndex, 2);
  });

  test("blank lead-in text is not pushed", () => {
    const state = {
      narration: [] as { index: number; text: string }[],
      assistantText: "   ",
      segmentIndex: 0,
      reissuePending: false,
    };
    closeLeadInNarration(state);
    assert.deepEqual(state.narration, []);
    assert.equal(state.segmentIndex, 1);
  });
});

describe("closeNarrationSegment", () => {
  // The premature-answer row of the same table: a finalize guard keeps the
  // rejected prose (the user already saw it stream) but must NOT advance when
  // there is nothing to close — no delta ever lands on the segment it would move
  // to, so the live client would stall on an index it never reaches.
  const prematureAnswer = { keepText: true, advanceWhenNothingKept: false } as const;

  test("a rejected answer is kept on the trail and advances the segment", () => {
    const state = {
      narration: [] as { index: number; text: string }[],
      assistantText: "I've created your spreadsheet.",
      segmentIndex: 0,
    };
    assert.equal(closeNarrationSegment(state, prematureAnswer), true);
    assert.deepEqual(state.narration, [{ index: 0, text: "I've created your spreadsheet." }]);
    assert.equal(state.assistantText, "");
    assert.equal(state.segmentIndex, 1);
  });

  test("with nothing to close it reports false and leaves the segment alone", () => {
    const state = {
      narration: [{ index: 0, text: "Working on it." }],
      assistantText: "  ",
      segmentIndex: 1,
    };
    assert.equal(closeNarrationSegment(state, prematureAnswer), false);
    assert.deepEqual(state.narration, [{ index: 0, text: "Working on it." }]);
    assert.equal(state.segmentIndex, 1);
  });
});
