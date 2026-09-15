import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EvidenceCard, EvidenceExpansionHandle } from "@alfred/contracts";
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
 * Behavioral tests for the expansion phase (#1077; ADR-0101 sub-decisions
 * 17-18).
 *
 * The phase is a POLICY, not a shape: which cards are worth a provider round
 * trip, who reads a handle, what a refresh is allowed to replace, and what the
 * boundary says about a source it did not ask. The compiler carries the reader
 * signature and `registerContextSource` carries the declaration parse; neither
 * can carry any of those four decisions, so each one is pinned here.
 *
 * Every assertion is on a DECLARATION — a handle kind against a manifest's
 * `expansionKinds` — and never on which source made it. Nothing below routes by
 * a source id, because the phase does not.
 *
 * Each test installs and disposes its own sources; node's runner isolates test
 * files in separate processes, and the disposers run in `finally`.
 */

const STALE_HANDLE: EvidenceExpansionHandle = {
  // The handle names a `sourceId` that can never expand it. Routing is by
  // `kind`, so a wrong name here must make no difference at all.
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
function liveCard(sourceId: string, id: string): EvidenceCard {
  return {
    id,
    source: { id: sourceId, kind: "native" },
    mediaKind: "text",
    snippet: "The live copy.",
    time: { freshness: "live" },
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

          return { evidence: [liveCard("expand-test:live", "live:1")] };
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

      // The ranking row still names the card the refresh replaced: the phase
      // runs after the rank and does not re-rank, so the refresh is visible in
      // a trace rather than silently rewriting the working.
      assert.equal(result.ranking.length, 1);
      assert.equal(result.ranking[0]?.cardId, "stale:1");

      // Exactly one report per registered source, and the live source's skip
      // is gone: it was consulted, so it reports what it actually did.
      assert.equal(result.sources.length, 2);
      assert.equal(reportFor(result, "expand-test:live")?.status, "ok");

      // The refreshed card belongs to the live source now, so the origin no
      // longer claims it. Without the transfer the packer would report the
      // refreshed card as an item it had dropped.
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

          return { evidence: [liveCard("expand-test:live", "live:1")] };
        }),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(calls, 0);
      assert.equal(result.evidence[0]?.id, "stale:1");

      // Never consulted, so the skip stands rather than becoming an `empty`
      // that would claim the source was asked and had nothing.
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

          return { evidence: [liveCard("expand-test:live", "live:1")] };
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
        // This source can expand, and it declares a different kind. Naming the
        // expander on the handle must not reach it either.
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => {
          calls += 1;

          return { evidence: [liveCard("expand-test:live", "live:1")] };
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

  test("two cards sharing one handle cost one expansion, and both sources run in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const expanded: string[] = [];

    /** Records overlap: a serial phase can never push `maxInFlight` past one. */
    function tracked(sourceId: string, cardId: string) {
      return async ({ handle }: { readonly handle: EvidenceExpansionHandle }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        expanded.push(handle.ref);

        await Promise.resolve();

        inFlight -= 1;

        return { evidence: [liveCard(sourceId, cardId)] };
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
      assert.equal(maxInFlight, 2);

      // The refresh takes the better-ranked of the two positions; the other
      // card keeps its own content rather than becoming a second copy.
      const ids = result.evidence.map((card) => card.id);

      assert.equal(ids.length, 3);
      assert.ok(ids.includes("live:a"));
      assert.ok(ids.includes("live:b"));
      assert.ok(ids.includes("stale:2"));
      assert.equal(new Set(ids).size, 3);
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
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => ({
          // Structurally a card, and it makes no freshness claim. The boundary
          // must not stamp `live` on the source's behalf.
          evidence: [
            { ...liveCard("expand-test:live", "live:1"), time: { freshness: "ingested" } },
          ],
        })),
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

  test("an expander with nothing to add reports empty, not error", async () => {
    const disposers = [
      registerContextSource(staleSource([staleCard("stale:1")])),
      registerContextSource(
        defineTestExpansionSource("expand-test:live", ["test_record"], async () => ({
          evidence: [],
        })),
      ),
    ];

    try {
      const result = await searchContext({ userId: "user-1", query: "anything" });

      assert.equal(result.evidence[0]?.id, "stale:1");

      const live = reportFor(result, "expand-test:live");

      assert.equal(live?.status, "empty");
      assert.equal(live?.evidenceCount, 0);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("registration binds the expand capability to its handle kinds", () => {
  test("a source that declares `expand` with no kind fails at boot", () => {
    assert.throws(() =>
      defineContextSource({
        id: "expand-test:kindless",
        manifest: { kind: "native", authority: { level: "medium" } },
        reads: { expand: async () => ({ evidence: [] }) },
      }),
    );
  });

  test("a source that names kinds with no `expand` reader fails at boot", () => {
    assert.throws(() =>
      defineContextSource({
        id: "expand-test:readerless",
        manifest: {
          kind: "native",
          authority: { level: "medium" },
          expansionKinds: ["test_record"],
        },
        reads: { semantic_search: async () => ({ evidence: [] }) },
      }),
    );
  });
});
