import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveLoopKey } from "@alfred/contracts";

/** Subjects are real prod shapes from the two loudest re-notifying senders, GitHub and ClickUp. */
describe("deriveLoopKey", () => {
  describe("GitHub notifications", () => {
    test("collapses a PR's review + comment emails onto one key", () => {
      // Different threads about one PR are one loop.
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
      assert.equal(deriveLoopKey("Notes on the A-1 form review"), null);
    });
  });

  describe("ClickUp / normalized-subject fallback (#283 regression)", () => {
    test("collapses re-notifications that share the task-title subject", () => {
      // Seen in prod: three threads within an hour for one ClickUp task.
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

  describe("monitoring alarms (#353 class 2 — SNS/CloudWatch)", () => {
    test("collapses recurring SNS alarm notifications onto one key (quoted name is the entity)", () => {
      const a = deriveLoopKey('ALARM: "Baserow response time alarm" in eu-west-1', {
        sender: "no-reply@sns.amazonaws.com",
      });

      const b = deriveLoopKey(
        'ALARM: "Baserow response time alarm" in us-east-1 — threshold breached 5',
        { sender: "no-reply@sns.amazonaws.com" },
      );

      assert.equal(a, "alarm:baserow response time alarm");
      assert.equal(b, a);
    });

    test("handles unquoted ELK-style ALERT subject via dash/in split", () => {
      const key = deriveLoopKey("ALERT: ElastiCache Current Connection - threshold exceeded", {
        sender: "no-reply@sns.amazonaws.com",
      });

      assert.equal(key, "alarm:elasticache current connection");
    });

    test("requires a monitoring sender — a human ALARM subject does not key", () => {
      assert.equal(
        deriveLoopKey('ALARM: "Baserow response time alarm" in eu-west-1', {
          sender: "priya@client.com",
        }),
        null,
      );
      assert.equal(deriveLoopKey("ALARM: Baserow response time alarm"), null);
    });

    test("keeps distinct alarms separate", () => {
      const a = deriveLoopKey('ALARM: "Baserow response time alarm" in eu-west-1', {
        sender: "no-reply@sns.amazonaws.com",
      });

      const b = deriveLoopKey("ALARM: ElastiCache Current Connection in eu-west-1", {
        sender: "no-reply@sns.amazonaws.com",
      });

      assert.notEqual(a, b);
    });
  });

  describe("no usable signal", () => {
    test("returns null for empty / subject-less mail", () => {
      assert.equal(deriveLoopKey(null), null);
      assert.equal(deriveLoopKey(undefined), null);
      assert.equal(deriveLoopKey(""), null);
      assert.equal(deriveLoopKey("   "), null);
      // The persisted sentinel for a subject-less email.
      assert.equal(deriveLoopKey("(no subject)"), null);
    });
  });
});
