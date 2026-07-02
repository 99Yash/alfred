import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveLoopKey } from "../../src/modules/briefing/loop-key";

/**
 * Subjects here are the real shapes pulled from prod (Gmail `documents.title`):
 * GitHub `notifications@github.com` and ClickUp `notifications@tasks.clickup.com`
 * were the two dominant re-notifying senders behind #283.
 */
describe("deriveLoopKey", () => {
  describe("GitHub notifications", () => {
    test("collapses a PR's review + comment emails onto one key", () => {
      // Two separate emails (a review, then a comment) about the same PR arrive
      // on different threads; both must resolve to the same loop.
      const review = deriveLoopKey(
        "Re: [OlivAIRepo/baserow-middleware] Stop dictation harvest (PR #786)",
      );
      const comment = deriveLoopKey(
        "Re: [OlivAIRepo/baserow-middleware] Stop dictation harvest (PR #786)",
      );
      assert.equal(review, "gh:olivairepo/baserow-middleware#786");
      assert.equal(comment, review);
    });

    test("keeps distinct PRs in the same repo separate", () => {
      const a = deriveLoopKey("Re: [OlivAIRepo/autosched-mirror] View Save gated (PR #724)");
      const b = deriveLoopKey("Re: [OlivAIRepo/autosched-mirror] Grey out cells (PR #749)");
      assert.equal(a, "gh:olivairepo/autosched-mirror#724");
      assert.equal(b, "gh:olivairepo/autosched-mirror#749");
      assert.notEqual(a, b);
    });

    test("keeps the same PR number in different repos separate", () => {
      const a = deriveLoopKey("Re: [OlivAIRepo/baserow-middleware] X (PR #727)");
      const b = deriveLoopKey("Re: [OlivAIRepo/autosched-mirror] Y (PR #727)");
      assert.notEqual(a, b);
    });

    test("handles Issue and bare-number forms", () => {
      assert.equal(deriveLoopKey("Re: [owner/repo] Some bug (Issue #12)"), "gh:owner/repo#12");
      assert.equal(deriveLoopKey("Re: [owner/repo] Some bug (#12)"), "gh:owner/repo#12");
    });
  });

  describe("Linear / Jira issue keys", () => {
    test("extracts a bracketed issue key", () => {
      assert.equal(deriveLoopKey("[ENG-123] Fix the flaky test"), "issue:eng-123");
      assert.equal(deriveLoopKey("Re: (PROJ-45) Ship the thing"), "issue:proj-45");
    });

    test("extracts a leading issue key", () => {
      assert.equal(deriveLoopKey("ENG-900: investigate latency"), "issue:eng-900");
      assert.equal(deriveLoopKey("Re: ENG-900: investigate latency"), "issue:eng-900");
    });

    test("does not treat a mid-sentence token as an issue key", () => {
      // A hyphenated word mid-subject must not masquerade as an issue key.
      assert.equal(deriveLoopKey("Notes on the A-1 form review"), null);
    });
  });

  describe("ClickUp / normalized-subject fallback (#283 regression)", () => {
    test("collapses re-notifications that share the task-title subject", () => {
      // Verified prod repeat: this exact ClickUp task title arrived on 3 separate
      // notification emails within an hour. Each is its own Gmail thread, but the
      // loop is one.
      const first = deriveLoopKey(
        "Netsmart: Opening Isabelle's account doesn't open favorite view",
        {
          sender: "ClickUp <notifications@tasks.clickup.com>",
        },
      );
      const second = deriveLoopKey(
        "Netsmart: Opening Isabelle's account doesn't open favorite view",
        { sender: "ClickUp" },
      );
      assert.equal(
        first,
        "subj:clickup:netsmart: opening isabelle's account doesn't open favorite view",
      );
      assert.equal(first, second);
    });

    test("collapses across a Re: prefix and whitespace/case noise", () => {
      const morning = deriveLoopKey("Netsmart: Save view issues", { sender: "ClickUp" });
      const evening = deriveLoopKey("Re:   netsmart: SAVE view issues  ", {
        sender: "ClickUp <notifications@tasks.clickup.com>",
      });
      assert.equal(morning, evening);
    });

    test("keeps genuinely different tasks separate", () => {
      const a = deriveLoopKey("Netsmart: Save view issues", { sender: "ClickUp" });
      const b = deriveLoopKey("Conservice: Fix imports not triggering deal driver messages", {
        sender: "ClickUp",
      });
      assert.notEqual(a, b);
    });

    test("strips stacked reply/forward prefixes", () => {
      assert.equal(
        deriveLoopKey("Fwd: Re: Fwd: Buying committee fixes", { sender: "ClickUp" }),
        "subj:clickup:buying committee fixes",
      );
    });

    test("does not subject-key unknown or generic notification subjects", () => {
      assert.equal(deriveLoopKey("Netsmart: Save view issues"), null);
      assert.equal(deriveLoopKey("Engineering", { sender: "ClickUp" }), null);
      assert.equal(deriveLoopKey("Action required", { sender: "ClickUp" }), null);
    });

    test("scopes subject fallback by tracker sender", () => {
      const clickup = deriveLoopKey("Netsmart: Save view issues", { sender: "ClickUp" });
      const linear = deriveLoopKey("Netsmart: Save view issues", {
        sender: "Linear <notifications@linear.app>",
      });
      assert.notEqual(clickup, linear);
    });
  });

  describe("no usable signal", () => {
    test("returns null for empty / subject-less mail", () => {
      assert.equal(deriveLoopKey(null), null);
      assert.equal(deriveLoopKey(undefined), null);
      assert.equal(deriveLoopKey(""), null);
      assert.equal(deriveLoopKey("   "), null);
      // Gather's persisted sentinel for a subject-less email must never key.
      assert.equal(deriveLoopKey("(no subject)"), null);
    });
  });
});
