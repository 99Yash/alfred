import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  attentionBand,
  attentionScore,
  bucketSignificance,
  CATEGORY_BASE_DEMAND,
  DEMANDING_AT,
  isLikelyBulkSender,
  MUTED_BELOW,
  normalizeSubjectForRecurrence,
  scoreAttentionForItems,
} from "@alfred/contracts";

/**
 * Pins the presentation-layer attention scorer (ADR-0064, #210). The whole
 * point of this work is that demanding-ness is a deterministic render property
 * layered on top of the honest immutable category — so the formula's behavior
 * (and especially its safe-degradation and its load-bearing examples) is pinned
 * here, the cheap-to-cover pure surface.
 */
describe("attentionScore", () => {
  test("an unscored sender keeps the category base — today's intrinsic-only behavior", () => {
    // No graph row → significanceBand null → multiplier 1.0 → score === base.
    const r = attentionScore({ category: "awaiting_reply" });
    assert.equal(r.score, CATEGORY_BASE_DEMAND.awaiting_reply);
    assert.equal(r.band, "demanding");
  });

  test("a cold low-significance awaiting_reply (the LinkedIn ask) drops to the ambient tail", () => {
    const r = attentionScore({ category: "awaiting_reply", significanceBand: "weak" });
    assert.ok(r.score < MUTED_BELOW, `expected muted, got ${r.score}`);
    assert.equal(r.band, "muted");
  });

  test("a known-important awaiting_reply stays demanding", () => {
    const r = attentionScore({ category: "awaiting_reply", significanceBand: "strong" });
    assert.equal(r.band, "demanding");
  });

  test("significance never pushes a low category above its floor", () => {
    // strong significance multiplier is 1.0, not >1 — fyi stays muted.
    const r = attentionScore({ category: "fyi", significanceBand: "strong" });
    assert.equal(r.score, CATEGORY_BASE_DEMAND.fyi);
    assert.equal(r.band, "muted");
  });

  test("a recurring bot alarm decays out of the demanding lane (the CloudWatch-10x case)", () => {
    const first = attentionScore({ category: "urgent", isBulkSender: true, recurrenceIndex: 0 });
    assert.equal(first.band, "demanding");

    const tenth = attentionScore({ category: "urgent", isBulkSender: true, recurrenceIndex: 9 });
    assert.ok(tenth.score < first.score, "the 10th repeat must be less demanding than the 1st");
    assert.equal(tenth.band, "muted");
  });

  test("recurrence decays ONLY for bulk senders — a human repeating is not demoted", () => {
    const human = attentionScore({ category: "urgent", isBulkSender: false, recurrenceIndex: 9 });
    assert.equal(human.score, CATEGORY_BASE_DEMAND.urgent);
    assert.equal(human.band, "demanding");
  });

  test("an exposed-secret pin stays demanding through significance and recurrence", () => {
    const r = attentionScore({
      category: "urgent",
      significanceBand: "weak",
      isBulkSender: true,
      recurrenceIndex: 20,
      pinnedDemanding: true,
    });
    assert.equal(r.band, "demanding");
    assert.ok(r.score >= DEMANDING_AT);
  });

  test("score stays clamped to [0,1]", () => {
    for (const category of Object.keys(
      CATEGORY_BASE_DEMAND,
    ) as (keyof typeof CATEGORY_BASE_DEMAND)[]) {
      const r = attentionScore({
        category,
        significanceBand: "weak",
        isBulkSender: true,
        recurrenceIndex: 50,
      });
      assert.ok(r.score >= 0 && r.score <= 1, `${category} → ${r.score} out of range`);
    }
  });
});

describe("attentionBand", () => {
  test("cutoffs partition the range", () => {
    assert.equal(attentionBand(DEMANDING_AT), "demanding");
    assert.equal(attentionBand(DEMANDING_AT - 0.001), "normal");
    assert.equal(attentionBand(MUTED_BELOW), "normal");
    assert.equal(attentionBand(MUTED_BELOW - 0.001), "muted");
  });
});

describe("bucketSignificance", () => {
  test("buckets at the resolver's 0.66 / 0.33 cutoffs", () => {
    assert.equal(bucketSignificance(0.9), "strong");
    assert.equal(bucketSignificance(0.66), "strong");
    assert.equal(bucketSignificance(0.5), "moderate");
    assert.equal(bucketSignificance(0.33), "moderate");
    assert.equal(bucketSignificance(0.1), "weak");
  });
});

describe("isLikelyBulkSender", () => {
  test("matches unambiguous machine local-parts (with or without a display name)", () => {
    assert.ok(isLikelyBulkSender("no-reply@sns.amazonaws.com"));
    assert.ok(isLikelyBulkSender("AWS Notifications <no-reply@sns.amazonaws.com>"));
    assert.ok(isLikelyBulkSender("notifications@github.com"));
    assert.ok(isLikelyBulkSender("alerts@datadoghq.com"));
    assert.ok(isLikelyBulkSender("MAILER-DAEMON@example.com"));
  });

  test("does NOT match humans or ambiguous role mailboxes", () => {
    assert.equal(isLikelyBulkSender("Fabian <fabian@acme.com>"), false);
    assert.equal(isLikelyBulkSender("team@acme.com"), false);
    assert.equal(isLikelyBulkSender("support@acme.com"), false);
    assert.equal(isLikelyBulkSender("info@acme.com"), false);
    assert.equal(isLikelyBulkSender(null), false);
    assert.equal(isLikelyBulkSender(""), false);
  });
});

describe("scoreAttentionForItems", () => {
  test("a recurring bot alarm decays across the window; the first stays demanding", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      sender: "no-reply@sns.amazonaws.com",
      subject: `ALARM: CPU at ${80 + i}% (1${i}:00)`,
      category: "urgent" as const,
    }));
    const [first, ...rest] = scoreAttentionForItems(items);
    const tenth = rest[rest.length - 1];
    assert.ok(first && tenth);
    assert.equal(first.band, "demanding", "first sighting stays demanding");
    assert.equal(tenth.band, "muted", "the 10th identical alarm is muted");
    assert.ok(tenth.score < first.score);
  });

  test("a human sending the same subject twice is NOT demoted (recurrence gated on bulk)", () => {
    const [a, b] = scoreAttentionForItems([
      {
        sender: "Fabian <fabian@acme.com>",
        subject: "Contract review",
        category: "awaiting_reply",
      },
      {
        sender: "Fabian <fabian@acme.com>",
        subject: "Contract review",
        category: "awaiting_reply",
      },
    ]);
    assert.ok(a && b);
    assert.equal(a.band, b.band);
    assert.equal(b.score, CATEGORY_BASE_DEMAND.awaiting_reply);
  });

  test("distinct bot subjects don't decay each other", () => {
    const [a, b] = scoreAttentionForItems([
      { sender: "alerts@datadoghq.com", subject: "Disk space low", category: "urgent" },
      { sender: "alerts@datadoghq.com", subject: "Latency spike", category: "urgent" },
    ]);
    assert.ok(a && b);
    assert.equal(a.band, "demanding");
    assert.equal(b.band, "demanding");
  });

  test("assigns recurrence chronologically even when items arrive newest-first", () => {
    // Both live consumers (briefing + inbox rail) feed rows newest-first. The
    // FIRST chronological sighting must stay demanding; the latest (10th) copy
    // must decay — regardless of the order it's passed in.
    const newestFirst = Array.from({ length: 10 }, (_, i) => ({
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: CPU high",
      category: "urgent" as const,
      // i=0 is newest; oldest has the smallest timestamp.
      occurredAtMs: 10_000 - i * 1000,
    }));
    const results = scoreAttentionForItems(newestFirst);
    const newest = results[0];
    const oldest = results[results.length - 1];
    assert.ok(newest && oldest);
    // The newest copy is the 10th sighting → decayed; the oldest is the 1st.
    assert.equal(oldest.band, "demanding", "the first (oldest) sighting stays demanding");
    assert.equal(newest.band, "muted", "the latest (10th) copy decays out");
    assert.ok(newest.score < oldest.score);
  });

  test("aligns 1:1 with the input order", () => {
    const results = scoreAttentionForItems([
      { sender: "Fabian <fabian@acme.com>", subject: "Hi", category: "fyi" },
      { sender: "no-reply@x.com", subject: "Deploy ok", category: "urgent" },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.band, "muted"); // fyi base
    assert.equal(results[1]?.band, "demanding"); // urgent, first sighting
  });
});

describe("normalizeSubjectForRecurrence", () => {
  test("collapses numeric drift between repeats of the same alarm", () => {
    const a = normalizeSubjectForRecurrence("ALARM: CPU at 95% (14:32)");
    const b = normalizeSubjectForRecurrence("ALARM: CPU at 91% (15:10)");
    assert.equal(a, b);
  });

  test("strips reply/forward and bracketed prefixes", () => {
    const a = normalizeSubjectForRecurrence("Re: [FIRING] Disk space low");
    const b = normalizeSubjectForRecurrence("[FIRING] Disk space low");
    assert.equal(a, b);
    assert.equal(a, "disk space low");
  });

  test("is case- and whitespace-insensitive", () => {
    assert.equal(
      normalizeSubjectForRecurrence("  Deploy   FAILED  "),
      normalizeSubjectForRecurrence("deploy failed"),
    );
  });

  test("keeps distinct subjects distinct", () => {
    assert.notEqual(
      normalizeSubjectForRecurrence("Invoice overdue"),
      normalizeSubjectForRecurrence("Welcome aboard"),
    );
  });
});
