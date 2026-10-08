import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EvidenceCard, EvidenceExpansionHandle } from "@alfred/contracts";
import { CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS } from "@alfred/contracts";
import {
  packEvidenceCards,
  registerContextSource,
  searchContext,
  type ContextSource,
} from "@alfred/assistant/context-search";
import {
  defineContextSource,
  defineTestContextSource,
  defineTestExpansionSource,
} from "@alfred/assistant/context-search/test-support";

/**
 * Expansion phase policy (ADR-0101 sub-decisions 17-18): which cards earn a round trip,
 * who reads a handle, what a refresh may replace, and what a skip reports.
 * Routing is by handle `kind` against a manifest's `expansionKinds`, never by source id.
 */

const STALE_HANDLE: EvidenceExpansionHandle = {
  // This `sourceId` can never expand the handle. Routing is by `kind`, so the name must not matter.
  sourceId: "expand-test:stale",
  kind: "test_record",
  ref: "record-1",
};

/** An ingested card carrying a routable handle: the input the phase exists for. */
function staleCard(id: string, handle: EvidenceExpansionHandle = STALE_HANDLE): EvidenceCard {
  return {
    id,
    source: { id: "expand-test:stale", kind: "internal" },
    mediaKind: "text",
    snippet: "The stored copy.",
    score: 0.5,
    time: { freshness: "ingested" },
    expansion: handle,
  };
}

/** The source that produces the stale cards a refresh replaces. */
function staleSource(cards: readonly EvidenceCard[]): ContextSource {
  return defineTestContextSource("expand-test:stale", async () => ({ evidence: cards }));
}

/** A refreshed card from `sourceId`, declared live as the contract requires. */
function liveCard(
  sourceId: string,
  id: string,
  handle: EvidenceExpansionHandle = STALE_HANDLE,
): EvidenceCard {
  return {
    id,
    source: { id: sourceId, kind: "native" },
    mediaKind: "text",
    snippet: "The live copy.",
    time: { freshness: "live" },
    expansion: { sourceId, kind: handle.kind, ref: handle.ref },
  };
}

function reportFor(
  result: Awaited<ReturnType<typeof searchContext>>,
  sourceId: string,
): (typeof result.sources)[number] | undefined {
  return result.sources.find((report) => report.sourceId === sourceId);
}

describe("the expansion phase — a stale card is upgraded in place", () => {
  test("a routed handle replaces its card at the same rank position and declares itself live", async () => {
    const handles: EvidenceExpansionHandle[] = [];

    const disposers = [
      registerContextSource(staleSource([staleCard("stale:1")])),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async ({ handle }) => {
          handles.push(handle);

          return liveCard("expand-test:live", "live:1");
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      // Replaced, not appended: one card in, one card out.
      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0]?.id, "live:1");
      assert.equal(result.evidence[0]?.time?.freshness, "live");

      // The expander received the handle the card carried, whole.
      assert.deepEqual(handles, [STALE_HANDLE]);

      // The ranking row still names the replaced card: the phase runs after the rank and does not re-rank.
      assert.equal(result.ranking.length, 1);
      assert.equal(result.ranking[0]?.cardId, "stale:1");

      // One report per source. The live source was consulted, so its skip is gone.
      assert.equal(result.sources.length, 2);
      assert.equal(reportFor(result, "expand-test:live")?.status, "ok");

      // The refreshed card now belongs to the live source. Otherwise the packer reports it as dropped.
      const origin = reportFor(result, "expand-test:stale");

      assert.equal(origin?.status, "ok");
      assert.equal(origin?.evidenceCount, 0);

      const packed = packEvidenceCards(result);

      assert.equal(packed.omittedCount, 0);
      assert.equal(packed.truncated, false);
      assert.ok(!packed.text.includes("not shown"));
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("a card already declared live is never expanded", async () => {
    let calls = 0;

    const disposers = [
      registerContextSource(
        defineTestContextSource("expand-test:stale", async () => ({
          evidence: [{ ...staleCard("stale:1"), time: { freshness: "live" } }],
        })),
      ),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => {
          calls += 1;

          return liveCard("expand-test:live", "live:1");
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(calls, 0);
      assert.equal(result.evidence[0]?.id, "stale:1");

      // Never consulted, so the skip stands. `empty` would claim the source was asked.
      const live = reportFor(result, "expand-test:live");

      assert.equal(live?.status, "skipped");
      assert.equal(live?.status === "skipped" ? live.reason : undefined, "expansion-only");
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("the request flag turns the whole phase off", async () => {
    let calls = 0;

    const disposers = [
      registerContextSource(staleSource([staleCard("stale:1")])),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => {
          calls += 1;

          return liveCard("expand-test:live", "live:1");
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything", expand: false });

      assert.equal(calls, 0);
      assert.equal(result.evidence[0]?.id, "stale:1");
      assert.equal(reportFor(result, "expand-test:live")?.status, "skipped");
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("the expansion phase — routing reads the declaration alone", () => {
  test("a handle whose kind no source declared leaves its card untouched", async () => {
    let calls = 0;

    const disposers = [
      registerContextSource(
        staleSource([staleCard("stale:1", { ...STALE_HANDLE, kind: "unrouted_record" })]),
      ),
      registerContextSource(
        // This source can expand, but declares a different kind. Naming it on the handle must not reach it.
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => {
          calls += 1;

          return liveCard("expand-test:live", "live:1");
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(calls, 0);
      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0]?.id, "stale:1");

      const live = reportFor(result, "expand-test:live");

      assert.equal(live?.status, "skipped");
      assert.equal(live?.status === "skipped" ? live.reason : undefined, "expansion-only");
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("two cards sharing one handle cost one expansion, and each kind reaches its declarant", async () => {
    const expanded: string[] = [];

    /** One call per routed handle: the shared handle must cost one call. */
    function tracked(sourceId: string, cardId: string) {
      return async ({ handle }: { readonly handle: EvidenceExpansionHandle }) => {
        expanded.push(handle.ref);

        return liveCard(sourceId, cardId, handle);
      };
    }

    const disposers = [
      registerContextSource(
        staleSource([
          // Two cards, one record: the shared handle must cost one call.
          staleCard("stale:1"),
          staleCard("stale:2"),
          staleCard("stale:3", { ...STALE_HANDLE, kind: "other_record", ref: "record-2" }),
        ]),
      ),
      registerContextSource(
        defineTestExpansionSource(
          "expand-test:live-a",
          ["test_record"],
          tracked("expand-test:live-a", "live:a"),
        ),
      ),
      registerContextSource(
        defineTestExpansionSource(
          "expand-test:live-b",
          ["other_record"],
          tracked("expand-test:live-b", "live:b"),
        ),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.deepEqual(expanded.toSorted(), ["record-1", "record-2"]);

      // The refresh takes the better-ranked position, so this pins the exact order, not set membership.
      const ids = result.evidence.map((card) => card.id);

      assert.deepEqual(ids, ["live:a", "stale:2", "live:b"]);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("the expansion phase — the budget cap", () => {
  test("the phase spends CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS on the best-ranked handles and leaves the rest", async () => {
    const expanded: string[] = [];
    const cardCount = CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS + 2;

    // Distinct records, strictly descending scores, unique ids: the cap must spend its budget on the first handles.
    const cards = Array.from({ length: cardCount }, (_, index) => ({
      ...staleCard(`stale:${index + 1}`, { ...STALE_HANDLE, ref: `record-${index + 1}` }),
      score: 1 - index * 0.01,
    }));

    const disposers = [
      registerContextSource(staleSource(cards)),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async ({ handle }) => {
          expanded.push(handle.ref);

          return liveCard("expand-test:live", `live:${handle.ref}`, handle);
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      // The count cap bounds the round trips: exactly the cap, on the best-ranked handles.
      assert.equal(expanded.length, CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS);
      assert.deepEqual(
        expanded,
        Array.from(
          { length: CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS },
          (_, index) => `record-${index + 1}`,
        ),
      );

      // Replaced in place: refreshed cards come first, and passed-over cards keep stale content last.
      assert.deepEqual(
        result.evidence.map((card) => card.id),
        [
          ...Array.from(
            { length: CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS },
            (_, index) => `live:record-${index + 1}`,
          ),
          ...Array.from(
            { length: cardCount - CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS },
            (_, index) => `stale:${CONTEXT_SEARCH_MAX_LIVE_EXPANSIONS + index + 1}`,
          ),
        ],
      );
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("the expansion phase — a failure costs the read nothing", () => {
  test("a throwing expander leaves the original card and reports against the live source", async () => {
    const disposers = [
      registerContextSource(staleSource([staleCard("stale:1")])),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => {
          throw new Error("the provider refused");
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0]?.id, "stale:1");

      // The origin keeps its card AND its count: nothing replaced it.
      const origin = reportFor(result, "expand-test:stale");

      assert.equal(origin?.status, "ok");
      assert.equal(origin?.evidenceCount, 1);

      const live = reportFor(result, "expand-test:live");

      assert.equal(live?.status, "error");
      assert.equal(live?.evidenceCount, 0);

      const packed = packEvidenceCards(result);

      assert.ok(packed.text.includes("expand-test:live: unavailable"));
      assert.equal(packed.omittedCount, 0);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("a refresh that does not declare itself live is rejected", async () => {
    const disposers = [
      registerContextSource(staleSource([staleCard("stale:1")])),
      registerContextSource(
        defineTestExpansionSource(
          "expand-test:live",
          ["test_record"],
          async () =>
            // A card with no freshness claim. The boundary must not stamp `live` for the source.
            ({ ...liveCard("expand-test:live", "live:1"), time: { freshness: "ingested" } }),
        ),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence[0]?.id, "stale:1");
      assert.equal(reportFor(result, "expand-test:live")?.status, "error");
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("an expander with nothing to add leaves the skip standing, not error", async () => {
    const disposers = [
      registerContextSource(staleSource([staleCard("stale:1")])),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => undefined),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence[0]?.id, "stale:1");

      const live = reportFor(result, "expand-test:live");

      // The source was consulted only for a handle, never asked the query. The `expansion-only` skip stands.
      assert.equal(live?.status, "skipped");
      assert.equal(live?.status === "skipped" ? live.reason : undefined, "expansion-only");
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("registration binds the expand capability to its handle kinds", () => {
  test("a source that declares `expand` with no kind fails at boot", () => {
    assert.throws(
      () =>
        defineContextSource({
          id: "expand-test:kindless",
          manifest: { kind: "native", authority: { level: "medium" }, mediaKinds: ["text"] },
          reads: { expand: async () => undefined },
        }),
      /declares read capability "expand" with no expansion handle kinds/,
    );
  });

  test("a source that names kinds with no `expand` reader fails at boot", () => {
    assert.throws(
      () =>
        defineContextSource({
          id: "expand-test:readerless",
          manifest: {
            kind: "native",
            authority: { level: "medium" },
            mediaKinds: ["text"],
            expansionKinds: ["test_record"],
          },
          reads: { semantic_search: async () => ({ evidence: [] }) },
        }),
      /declares expansion handle kinds with no "expand" read capability/,
    );
  });
});
