import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BriefingGather } from "@alfred/contracts";

import { collectSurfacedThreadIds } from "../../src/modules/briefing/read";

/**
 * Minimal gather carrying only the fields `collectSurfacedThreadIds` reads.
 * `email.categories` is the source of the dedup signal; everything else is
 * filled with empty/quiet defaults so the fixture is a valid `BriefingGather`.
 */
function gatherWith(
  categories: BriefingGather["email"]["categories"],
): BriefingGather {
  return {
    email: { categories },
    calendar: null,
    integration_activity: { items: [] },
    weather: null,
    day_of_week: { dayName: "Monday", isWeekend: false },
  };
}

function emailItem(documentId: string, threadId: string) {
  return {
    documentId,
    threadId,
    subject: `subject-${documentId}`,
    sender: "Someone",
    snippet: "snippet",
  };
}

describe("collectSurfacedThreadIds", () => {
  test("collects thread ids across categories and briefings", () => {
    const morning = gatherWith({
      action_needed: [emailItem("d1", "thr_a"), emailItem("d2", "thr_b")],
      urgent: [emailItem("d3", "thr_c")],
    });
    const lastNight = gatherWith({
      awaiting_reply: [emailItem("d4", "thr_d")],
    });

    const ids = collectSurfacedThreadIds([morning, lastNight]);

    assert.deepEqual([...ids].sort(), ["thr_a", "thr_b", "thr_c", "thr_d"]);
  });

  test("dedupes the same thread surfaced in two briefings", () => {
    // The exact repetition the flag prevents: a thread in this morning's
    // action_needed reappearing in the evening as awaiting_reply.
    const morning = gatherWith({ action_needed: [emailItem("d1", "thr_x")] });
    const evening = gatherWith({ awaiting_reply: [emailItem("d2", "thr_x")] });

    const ids = collectSurfacedThreadIds([morning, evening]);

    assert.deepEqual([...ids], ["thr_x"]);
  });

  test("tolerates null gathers (suppressed rows that never gathered)", () => {
    const ids = collectSurfacedThreadIds([
      null,
      gatherWith({ urgent: [emailItem("d1", "thr_y")] }),
    ]);

    assert.deepEqual([...ids], ["thr_y"]);
  });

  test("returns an empty set when nothing was surfaced", () => {
    assert.equal(collectSurfacedThreadIds([]).size, 0);
    assert.equal(collectSurfacedThreadIds([gatherWith({})]).size, 0);
  });
})
