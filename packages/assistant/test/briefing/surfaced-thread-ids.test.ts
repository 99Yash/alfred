import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BriefingGather } from "@alfred/contracts";

import {
  collectSurfacedKeys,
  collectSurfacedLoopKeys,
  collectSurfacedThreadIds,
} from "@alfred/assistant/briefings/read";
import { deriveLoopKey } from "@alfred/contracts";

/** A valid `BriefingGather` where only `email.categories` matters. */
function gatherWith(categories: BriefingGather["email"]["categories"]): BriefingGather {
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

function emailItemWithSubject(documentId: string, threadId: string, subject: string) {
  return { documentId, threadId, subject, sender: "ClickUp", snippet: "snippet" };
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
    // A morning action_needed thread reappears in the evening as awaiting_reply.
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
});

describe("collectSurfacedLoopKeys", () => {
  test("collapses a re-notified ClickUp task across two slots (#283 regression)", () => {
    // The task re-notifies on a new thread; the same subject gives the same loop key.
    const subject = "Netsmart: Save view issues";

    const evening = gatherWith({
      urgent: [emailItemWithSubject("d-eve", "thr_evening", subject)],
    });

    const morning = gatherWith({
      urgent: [emailItemWithSubject("d-morn", "thr_morning", `Re: ${subject}`)],
    });

    assert.notEqual(
      [...collectSurfacedThreadIds([evening, morning])].length,
      1,
      "sanity: the thread ids are genuinely different",
    );
    const loopKeys = collectSurfacedLoopKeys([evening, morning]);
    assert.deepEqual([...loopKeys], [deriveLoopKey(subject, { sender: "ClickUp" })]);
  });

  test("lines up with the current-window derivation", () => {
    // previouslySurfaced compares the persisted key with the live key.
    const subject = "Re: [OlivAIRepo/baserow-middleware] Harden detection (PR #786)";
    const gather = gatherWith({ action_needed: [emailItemWithSubject("d1", "thr", subject)] });
    const [surfaced] = [...collectSurfacedLoopKeys([gather])];
    assert.equal(surfaced, deriveLoopKey(subject));
    assert.equal(surfaced, "gh:olivairepo/baserow-middleware#786");
  });

  test("skips items whose subject carries no usable key", () => {
    const gather = gatherWith({ urgent: [emailItemWithSubject("d1", "thr", "(no subject)")] });
    assert.equal(collectSurfacedLoopKeys([gather]).size, 0);
  });

  test("tolerates null gathers and empty categories", () => {
    assert.equal(collectSurfacedLoopKeys([null, gatherWith({})]).size, 0);
    assert.equal(collectSurfacedLoopKeys([]).size, 0);
  });
});

describe("collectSurfacedKeys", () => {
  test("uses only document ids the delivered prose actually surfaced", () => {
    const surfacedSubject = "Netsmart: Save view issues";
    const omittedSubject = "Conservice: Fix imports not triggering deal driver messages";

    const gather = gatherWith({
      urgent: [
        emailItemWithSubject("d-surfaced", "thr_surfaced", surfacedSubject),
        emailItemWithSubject("d-omitted", "thr_omitted", omittedSubject),
      ],
    });

    const keys = collectSurfacedKeys([
      {
        gather,
        fullBriefing: {
          headline: "Netsmart needs a look",
          sections: [],
          surfacedDocumentIds: ["d-surfaced"],
        },
      },
    ]);

    assert.deepEqual([...keys.threadIds], ["thr_surfaced"]);
    assert.deepEqual([...keys.loopKeys], [deriveLoopKey(surfacedSubject, { sender: "ClickUp" })]);
  });

  test("does not treat gathered-only items as already surfaced", () => {
    const gather = gatherWith({
      urgent: [emailItemWithSubject("d1", "thr_1", "Netsmart: Save view issues")],
    });

    const missingAuditField = collectSurfacedKeys([
      { gather, fullBriefing: { headline: "Something else", sections: [] } },
    ]);

    const uncited = collectSurfacedKeys([
      {
        gather,
        fullBriefing: {
          headline: "Something else",
          sections: [],
          surfacedDocumentIds: ["other-doc"],
        },
      },
    ]);

    assert.equal(missingAuditField.threadIds.size, 0);
    assert.equal(missingAuditField.loopKeys.size, 0);
    assert.equal(uncited.threadIds.size, 0);
    assert.equal(uncited.loopKeys.size, 0);
  });
});
