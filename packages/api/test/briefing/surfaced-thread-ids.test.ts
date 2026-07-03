import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BriefingGather } from "@alfred/contracts";

import {
  collectSurfacedKeys,
  collectSurfacedLoopKeys,
  collectSurfacedThreadIds,
} from "../../src/modules/briefing/read";
import { deriveLoopKey } from "@alfred/contracts";

/**
 * Minimal gather carrying only the fields `collectSurfacedThreadIds` reads.
 * `email.categories` is the source of the dedup signal; everything else is
 * filled with empty/quiet defaults so the fixture is a valid `BriefingGather`.
 */
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
});

describe("collectSurfacedLoopKeys", () => {
  test("collapses a re-notified ClickUp task across two slots (#283 regression)", () => {
    // The motivating case: an urgent ClickUp task surfaced in the evening
    // re-notifies on a NEW thread (a comment) before morning. The thread ids
    // differ, so a thread-keyed dedup misses it — but the task-title subject is
    // identical, so the loop key collapses the two.
    const subject = "Netsmart: Save view issues";
    const evening = gatherWith({
      urgent: [emailItemWithSubject("d-eve", "thr_evening", subject)],
    });
    const morning = gatherWith({
      // Later notification: different thread, same underlying task.
      urgent: [emailItemWithSubject("d-morn", "thr_morning", `Re: ${subject}`)],
    });

    // Both slots contribute the SAME loop key though their thread ids differ.
    assert.notEqual(
      [...collectSurfacedThreadIds([evening, morning])].length,
      1,
      "sanity: the thread ids are genuinely different",
    );
    const loopKeys = collectSurfacedLoopKeys([evening, morning]);
    assert.deepEqual([...loopKeys], [deriveLoopKey(subject, { sender: "ClickUp" })]);
  });

  test("lines up with the current-window derivation", () => {
    // The persisted-item key and the live-document key must be byte-identical,
    // since previouslySurfaced compares one against the other.
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
