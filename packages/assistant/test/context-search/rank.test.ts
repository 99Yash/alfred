import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EvidenceCard } from "@alfred/contracts";
import { registerContextSource, searchContext } from "@alfred/assistant/context-search";
import {
  defineTestContextSource,
  entitySignificanceKey,
  rankEvidenceCards,
} from "@alfred/assistant/context-search/test-support";

/**
 * Deterministic evidence ranker. Tests assert order and feature presence, never a score
 * literal, so tuning weights does not break them. An unavailable optional signal is dropped,
 * not zeroed; `semantic`, `freshness`, and `authority` read silence as a defined row.
 */

/** A fixed clock. Every relative instant below is measured back from this. */
const NOW = new Date("2026-09-14T12:00:00.000Z");

const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** A minimal valid card. Each case overrides only the field under test. */
function card(overrides: Partial<EvidenceCard> & Pick<EvidenceCard, "id">): EvidenceCard {
  return {
    source: { id: "documents", kind: "internal" },
    mediaKind: "text",
    snippet: "evidence",
    ...overrides,
  };
}

function orderOf(cards: readonly EvidenceCard[], context = { now: NOW }): string[] {
  return rankEvidenceCards(cards, context).evidence.map((ranked) => ranked.id);
}

describe("rankEvidenceCards — exact match against semantic hits", () => {
  test("a resolved object outranks a strong semantic hit from another source", () => {
    const strongChunk = card({ id: "documents:chunk", score: 0.98 });

    const resolvedObject = card({
      id: "object-state:pr-1",
      source: { id: "object-state", kind: "internal" },
      score: 1,
      object: {
        provider: "github",
        kind: "pull_request",
        externalId: "1",
        relation: "is",
        stateCategory: "active",
        nativeState: "open",
      },
      time: { observedAt: daysAgo(1), freshness: "ingested" },
    });

    assert.deepEqual(orderOf([strongChunk, resolvedObject]), [
      "object-state:pr-1",
      "documents:chunk",
    ]);
  });

  test("an unresolved object-state miss ranks below a weak semantic hit", () => {
    // The miss card resolved no object, so `exactMatch` must not reward it for its source.
    const weakChunk = card({ id: "documents:chunk", score: 0.2 });

    const miss = card({
      id: "object-state:missing",
      source: { id: "object-state", kind: "internal" },
      score: 0,
      snippet: undefined,
      note: "No GitHub object resolves this head_sha key.",
      time: { freshness: "unknown" },
    });

    assert.deepEqual(orderOf([miss, weakChunk]), ["documents:chunk", "object-state:missing"]);
  });
});

describe("rankEvidenceCards — stale against fresh", () => {
  test("a live recent card beats a stale card that scored higher", () => {
    const stale = card({
      id: "documents:old",
      score: 0.7,
      time: { occurredAt: daysAgo(200), freshness: "stale" },
    });

    const fresh = card({
      id: "documents:new",
      score: 0.6,
      time: { occurredAt: daysAgo(0), freshness: "live" },
    });

    assert.deepEqual(orderOf([stale, fresh]), ["documents:new", "documents:old"]);
  });

  test("a declared-stale card ranks below one that could not declare freshness", () => {
    // `stale` is a declared problem, so it ranks below `unknown`. Neither is inferred from a missing timestamp.
    const stale = card({ id: "documents:a", score: 0.5, time: { freshness: "stale" } });
    const silent = card({ id: "documents:b", score: 0.5, time: { freshness: "unknown" } });

    assert.deepEqual(orderOf([stale, silent]), ["documents:b", "documents:a"]);
  });

  test("an open work object outranks an identical resolved one", () => {
    const base = {
      provider: "github" as const,
      kind: "pull_request",
      externalId: "1",
      relation: "is" as const,
      nativeState: "open",
    };

    const open = card({
      id: "object-state:open",
      source: { id: "object-state", kind: "internal" },
      score: 1,
      object: { ...base, stateCategory: "active" },
      time: { observedAt: daysAgo(2), freshness: "ingested" },
    });

    const closed = card({
      id: "object-state:closed",
      source: { id: "object-state", kind: "internal" },
      score: 1,
      object: { ...base, externalId: "2", stateCategory: "resolved" },
      time: { observedAt: daysAgo(2), freshness: "ingested" },
    });

    assert.deepEqual(orderOf([closed, open]), ["object-state:open", "object-state:closed"]);
  });
});

describe("rankEvidenceCards — tie-breaking", () => {
  test("cards that tie on every feature order by id, whatever order they arrive in", () => {
    const a = card({ id: "documents:a", score: 0.5, time: { freshness: "ingested" } });
    const b = card({ id: "documents:b", score: 0.5, time: { freshness: "ingested" } });
    const c = card({ id: "documents:c", score: 0.5, time: { freshness: "ingested" } });

    const forward = orderOf([a, b, c]);
    const reversed = orderOf([c, b, a]);

    // A tie resolves to ascending id. Comparing two runs proves the sort is total, not registration order.
    assert.deepEqual(forward, ["documents:a", "documents:b", "documents:c"]);
    assert.deepEqual(reversed, forward);
  });

  test("scores that differ only by floating-point noise count as a tie", () => {
    // 0.1 + 0.2 !== 0.3: bit-different equal scores must still tie and fall through to the id.
    const noisy = card({ id: "documents:b", score: 0.1 + 0.2 });
    const exact = card({ id: "documents:a", score: 0.3 });

    assert.deepEqual(orderOf([noisy, exact]), ["documents:a", "documents:b"]);
  });
});

describe("rankEvidenceCards — degradation when a signal is absent", () => {
  test("a card with no score reads as low relevance, not zero", () => {
    const unscored = card({
      id: "mcp:unscored",
      source: { id: "mcp:notes", kind: "mcp" },
      time: { freshness: "live" },
    });

    const zeroScored = card({
      id: "documents:zero",
      score: 0,
      time: { freshness: "live" },
    });

    const ranked = rankEvidenceCards([zeroScored, unscored], { now: NOW });

    assert.deepEqual(
      ranked.evidence.map((entry) => entry.id),
      ["mcp:unscored", "documents:zero"],
    );
    // An unscored card carries `semantic` at the unknown floor; a zero-scored one carries 0.
    // An explicit non-match still ranks below an unmeasured match.
    assert.equal(ranked.ranking[0]?.features.semantic, 0.3);
    assert.equal(ranked.ranking[1]?.features.semantic, 0);
  });

  test("a card with no timestamp is not treated as infinitely old", () => {
    const timeless = card({ id: "memory:a", score: 0.5, time: { freshness: "ingested" } });

    const ancient = card({
      id: "documents:a",
      score: 0.5,
      time: { occurredAt: daysAgo(400), freshness: "ingested" },
    });

    const ranked = rankEvidenceCards([ancient, timeless], { now: NOW });

    assert.deepEqual(
      ranked.evidence.map((entry) => entry.id),
      ["memory:a", "documents:a"],
    );
    assert.equal(ranked.ranking[0]?.features.recency, undefined);
  });

  test("an undeclared authority is never promoted, and never punished below a declared low", () => {
    const declaredHigh = card({
      id: "documents:high",
      score: 0.5,
      authority: { level: "high", label: "GitHub App webhook" },
    });

    const undeclared = card({
      id: "mcp:silent",
      source: { id: "mcp:notes", kind: "mcp" },
      score: 0.5,
    });

    const declaredLow = card({ id: "documents:low", score: 0.5, authority: { level: "low" } });

    assert.deepEqual(orderOf([undeclared, declaredLow, declaredHigh]), [
      "documents:high",
      "mcp:silent",
      "documents:low",
    ]);
  });

  test("an arbitrary source scale is normalized within its own source", () => {
    // MCP scores on 0-100 and documents on cosine similarity. Without per-source normalization, MCP always wins.
    const mcpBest = card({ id: "mcp:best", source: { id: "mcp:notes", kind: "mcp" }, score: 90 });
    const mcpWorst = card({ id: "mcp:worst", source: { id: "mcp:notes", kind: "mcp" }, score: 10 });
    const document = card({ id: "documents:good", score: 0.8 });

    assert.deepEqual(orderOf([mcpWorst, mcpBest, document]), [
      "mcp:best",
      "documents:good",
      "mcp:worst",
    ]);
  });
});

describe("rankEvidenceCards — user-model signal", () => {
  const known = card({
    id: "documents:known",
    score: 0.5,
    entities: [{ kind: "email", value: "ada@example.com" }],
  });

  const unknown = card({
    id: "documents:unknown",
    score: 0.5,
    entities: [{ kind: "email", value: "stranger@example.com" }],
  });

  test("a card about a weighted entity outranks an otherwise identical card", () => {
    const ranked = rankEvidenceCards([unknown, known], {
      now: NOW,
      entitySignificance: new Map([[entitySignificanceKey("email", "ada@example.com"), 1]]),
    });

    assert.deepEqual(
      ranked.evidence.map((entry) => entry.id),
      ["documents:known", "documents:unknown"],
    );
    assert.equal(ranked.ranking[0]?.features.userModel, 1);
    // An entity the projection does not know gets no feature, not a zero.
    assert.equal(ranked.ranking[1]?.features.userModel, undefined);
  });

  test("with no active projection the order falls back to id, and no card carries the feature", () => {
    // ADR-0067 degradation path: no `entitySignificance` map, so the two cards tie and the id decides.
    const ranked = rankEvidenceCards([known, unknown], { now: NOW });

    assert.deepEqual(
      ranked.evidence.map((entry) => entry.id),
      ["documents:known", "documents:unknown"],
    );

    for (const entry of ranked.ranking) assert.equal(entry.features.userModel, undefined);
  });
});

describe("rankEvidenceCards — manifest-driven source priority", () => {
  const fromTrusted = card({
    id: "a:card",
    source: { id: "trusted-source", kind: "native" },
    score: 0.5,
  });

  const fromUndescribed = card({
    id: "b:card",
    source: { id: "undescribed-source", kind: "mcp" },
    score: 0.5,
  });

  test("a manifest priority reorders two sources that otherwise tie", () => {
    const ranked = rankEvidenceCards([fromTrusted, fromUndescribed], {
      now: NOW,
      sourcePriority: new Map([
        ["undescribed-source", 1],
        ["trusted-source", 0],
      ]),
    });

    assert.deepEqual(
      ranked.evidence.map((entry) => entry.id),
      ["b:card", "a:card"],
    );
  });

  test("a source the manifest does not list carries no priority feature", () => {
    const ranked = rankEvidenceCards([fromTrusted, fromUndescribed], {
      now: NOW,
      sourcePriority: new Map([["trusted-source", 1]]),
    });

    const undescribed = ranked.ranking.find((entry) => entry.sourceId === "undescribed-source");

    assert.equal(undescribed?.features.sourcePriority, undefined);
    assert.deepEqual(
      ranked.evidence.map((entry) => entry.id),
      ["a:card", "b:card"],
    );
  });
});

describe("rankEvidenceCards — the caller's declared focus", () => {
  test("evidence about a declared object outranks evidence about another object", () => {
    const declared = card({
      id: "object-state:declared",
      source: { id: "object-state", kind: "internal" },
      score: 1,
      object: {
        provider: "github",
        kind: "pull_request",
        externalId: "7",
        relation: "is",
        stateCategory: "active",
      },
      time: { observedAt: daysAgo(3), freshness: "ingested" },
    });

    const other = card({
      id: "object-state:other",
      source: { id: "object-state", kind: "internal" },
      score: 1,
      object: {
        provider: "github",
        kind: "pull_request",
        externalId: "8",
        relation: "is",
        stateCategory: "active",
      },
      time: { observedAt: daysAgo(3), freshness: "ingested" },
    });

    const order = rankEvidenceCards([other, declared], {
      now: NOW,
      objects: [{ by: "identity", provider: "github", kind: "pull_request", externalId: "7" }],
    }).evidence.map((entry) => entry.id);

    assert.deepEqual(order, ["object-state:declared", "object-state:other"]);
  });

  test("a request that declares no object gives no card a focus feature", () => {
    const ranked = rankEvidenceCards([card({ id: "documents:a", score: 0.5 })], { now: NOW });

    assert.equal(ranked.ranking[0]?.features.focus, undefined);
  });
});

describe("searchContext — ranking runs before the limit truncation", () => {
  test("a strong card from a late-registered source survives a limit of one", async () => {
    // Regression #427: cards were concatenated in registration order and sliced, so `strong` was dropped unseen.
    const disposeWeak = registerContextSource(
      defineTestContextSource("rank-test:weak", async () => {
        return {
          evidence: [
            {
              id: "rank-test:weak:1",
              source: { id: "rank-test:weak", kind: "native" },
              mediaKind: "text",
              snippet: "A barely relevant chunk.",
              score: 0.05,
              time: { freshness: "stale" },
            },
          ],
        };
      }),
    );

    const disposeStrong = registerContextSource(
      defineTestContextSource("rank-test:strong", async () => {
        return {
          evidence: [
            {
              id: "rank-test:strong:1",
              source: { id: "rank-test:strong", kind: "native" },
              mediaKind: "text",
              snippet: "The answer.",
              score: 0.95,
              authority: { level: "high" },
              time: { freshness: "live" },
            },
          ],
        };
      }),
    );

    try {
      const result = await searchContext({ userId: "user-1", query: "anything", limit: 1 });

      assert.deepEqual(
        result.evidence.map((entry) => entry.id),
        ["rank-test:strong:1"],
      );
      // The dropped source still reports what it returned, so the packer can name the budget cut.
      assert.equal(
        result.sources.find((report) => report.sourceId === "rank-test:weak")?.evidenceCount,
        1,
      );
    } finally {
      disposeStrong();
      disposeWeak();
    }
  });

  test("ranking metadata is parallel to the returned evidence", async () => {
    const dispose = registerContextSource(
      defineTestContextSource("rank-test:pair", async () => {
        return {
          evidence: [
            {
              id: "rank-test:pair:1",
              source: { id: "rank-test:pair", kind: "native" },
              mediaKind: "text",
              snippet: "One.",
              score: 0.4,
            },
            {
              id: "rank-test:pair:2",
              source: { id: "rank-test:pair", kind: "native" },
              mediaKind: "text",
              snippet: "Two.",
              score: 0.9,
            },
          ],
        };
      }),
    );

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.deepEqual(
        result.ranking.map((entry) => entry.cardId),
        result.evidence.map((entry) => entry.id),
      );
      // tautology-ok: cross-check that the parallel array tracks evidence order, anchored at rank.test.ts:453-456
      assert.deepEqual(
        result.evidence.map((entry) => entry.id),
        ["rank-test:pair:2", "rank-test:pair:1"],
      );
      // Every card scored, and the order is the score order.
      assert.ok((result.ranking[0]?.score ?? 0) > (result.ranking[1]?.score ?? 0));
    } finally {
      dispose();
    }
  });
});
