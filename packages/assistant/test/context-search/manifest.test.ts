import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type ContextSearchRequest,
  type EvidenceCard,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import {
  isTrustedRetrievalSource,
  registerContextSource,
  searchContext,
  selectContextSources,
  type ContextSource,
} from "@alfred/assistant/context-search";
import { defineContextSource } from "@alfred/assistant/context-search/test-support";

/**
 * Behavioral tests for the source capability manifest (#466; ADR-0101
 * sub-decisions 14-16).
 *
 * The manifest is a DISCOVERY contract, so what has to be proved is which
 * sources a read consults and what it says about the ones it does not. The
 * compiler already carries the shape, and `registerContextSource` already
 * carries the parse; neither can carry the selection policy, because that is a
 * decision rather than a type. These tests pin the cases the policy exists
 * for: a fully described source, a described MCP-backed source, a source that
 * declares itself unavailable, and an exact-lookup source facing a free-text
 * query. A source that forgets its read or authority declaration never reaches
 * selection — registration rejects it — so those cases assert a throw rather
 * than an exclusion reason.
 *
 * The selection never reads a source id, so every assertion below is on the
 * DECLARATION a source makes and never on which source made it.
 */

/** A card from `sourceId`, so a consulted source is provably consulted. */
function cardFrom(sourceId: string): EvidenceCard {
  return {
    id: `${sourceId}:1`,
    source: { id: sourceId, kind: "native" },
    mediaKind: "text",
    snippet: "Evidence.",
    score: 0.5,
  };
}

/**
 * A source that records whether it was read. "Skipped" must mean no reader
 * ran, not that its output was discarded afterwards — the whole point of
 * excluding a source is not paying for it. The id is stated once on the
 * manifest fixture; the registry mints it into the source and derives `read`
 * from the readers, so the fixture never repeats either beside the manifest.
 */
function recordingSource(manifest: RetrievalSourceManifest) {
  let read = false;

  async function handler() {
    read = true;

    return { evidence: [cardFrom(manifest.id)] };
  }

  const { id, read: _read, ...fragment } = manifest;

  const source: ContextSource = defineContextSource({
    id,
    manifest: fragment,
    // SAFETY: entries are built from manifest.read keys, so the record keys are capabilities by construction.
    reads: Object.fromEntries(
      manifest.read.map((capability) => [capability, handler] as const),
    ) as ContextSource["reads"],
  });

  return { source, wasRead: () => read };
}

const NATIVE: RetrievalSourceManifest = {
  id: "manifest-test:native",
  kind: "native",
  integration: "github",
  read: ["semantic_search", "exact_lookup"],
  freshness: { typical: "live" },
  authority: { level: "high", label: "GitHub App" },
  cost: { class: "remote" },
  availability: "available",
};

/** A described MCP server: remote and third-party, but it said how to read it. */
const DESCRIBED_MCP: RetrievalSourceManifest = {
  id: "manifest-test:mcp-described",
  kind: "mcp",
  displayName: "A described MCP server",
  read: ["semantic_search"],
  authority: { level: "low", label: "third-party MCP server" },
  cost: { class: "remote" },
  availability: "available",
};

/** The same server before anyone described it. Callable, not questionable. */
const UNDESCRIBED_MCP: SourceManifest = {
  id: "manifest-test:mcp-undescribed",
  kind: "mcp",
};

/** Described, readable, and temporarily out of service. */
const UNAVAILABLE: RetrievalSourceManifest = {
  id: "manifest-test:unavailable",
  kind: "native",
  read: ["semantic_search"],
  authority: { level: "medium" },
  availability: "unavailable",
};

/** Read semantics but no provenance: half a description is not a description. */
const NO_AUTHORITY: SourceManifest = {
  id: "manifest-test:no-authority",
  kind: "native",
  read: ["semantic_search"],
};

/** Deterministic lookups only — it cannot answer a free-text question. */
const EXACT_ONLY: RetrievalSourceManifest = {
  id: "manifest-test:exact-only",
  kind: "internal",
  read: ["exact_lookup"],
  authority: { level: "high" },
};

const QUERY: ContextSearchRequest = {
  userId: "user-1",
  query: "anything",
  // The expansion phase (#1077) is on by default. These tests register no
  // expander, so it routes nothing; stating it keeps the selection assertions
  // about the FIRST phase alone.
  expand: true,
  limit: 10,
};

function select(
  manifests: readonly RetrievalSourceManifest[],
  request: ContextSearchRequest = QUERY,
) {
  const sources = manifests.map((manifest) => recordingSource(manifest).source);

  return selectContextSources(sources, request);
}

function reasonFor(selection: ReturnType<typeof select>, sourceId: string): string | undefined {
  return selection.get(sourceId);
}

describe("selectContextSources — who gets asked", () => {
  test("a fully described native source is a candidate", () => {
    const selection = select([NATIVE]);

    assert.equal(selection.size, 0);
  });

  test("a described MCP source is a candidate on the same terms as a native one", () => {
    // Trust follows the declaration, not the author: `kind` never appears in
    // the selection, so a third-party server that declared its read semantics
    // and its provenance is asked exactly as a first-party source is.
    const selection = select([DESCRIBED_MCP]);

    assert.equal(selection.size, 0);
  });

  test("a source that forgets its read declaration fails at registration, not at read time", () => {
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally registers a catalog-loose manifest to prove the retrieval boundary rejects it at boot.
    const manifest = UNDESCRIBED_MCP as RetrievalSourceManifest;

    assert.throws(() =>
      registerContextSource({
        id: manifest.id,
        manifest,
        reads: {},
      }),
    );
  });

  test("a source that declares read semantics but no authority fails at registration", () => {
    // The half-described case used to go dark behind a `skipped` line for the
    // life of the process. Registration now rejects it, so a forgotten
    // authority stops the boot instead of reading as ordinary output.
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally registers a catalog-loose manifest to prove the retrieval boundary rejects it at boot.
    const manifest = NO_AUTHORITY as RetrievalSourceManifest;

    assert.throws(() =>
      registerContextSource({
        id: manifest.id,
        manifest,
        reads: { semantic_search: async () => ({ evidence: [] }) },
      }),
    );
  });

  test("a source that declares itself unavailable is excluded", () => {
    const selection = select([UNAVAILABLE]);

    assert.equal(reasonFor(selection, UNAVAILABLE.id), "unavailable");
  });

  test("an exact-lookup source is skipped for a query that declares no object", () => {
    const selection = select([EXACT_ONLY]);

    assert.equal(reasonFor(selection, EXACT_ONLY.id), "no-answering-read");
  });

  test("the same exact-lookup source is a candidate once the request declares an object", () => {
    const selection = select([EXACT_ONLY], {
      ...QUERY,
      objects: [{ by: "identity", provider: "github", kind: "pull_request", externalId: "1" }],
    });

    assert.equal(selection.size, 0);
  });
});

describe("searchContext — an excluded source is reported, not hidden", () => {
  test("an unavailable source is never read and is reported skipped with its reason", async () => {
    const described = recordingSource(DESCRIBED_MCP);
    const unavailable = recordingSource(UNAVAILABLE);

    const disposers = [
      registerContextSource(described.source),
      registerContextSource(unavailable.source),
    ];

    try {
      const result = await searchContext(QUERY);

      // Skipping must save the read, not discard its output afterwards.
      assert.equal(described.wasRead(), true);
      assert.equal(unavailable.wasRead(), false);

      assert.deepEqual(
        result.evidence.map((card) => card.source.id),
        [DESCRIBED_MCP.id],
      );

      const report = result.sources.find((one) => one.sourceId === UNAVAILABLE.id);

      // `skipped` is its own status: "never asked" must not read as "asked and
      // found nothing", or absence becomes evidence of absence.
      assert.equal(report?.status, "skipped");
      assert.equal(report?.status === "skipped" ? report.reason : undefined, "unavailable");
      assert.equal(report?.evidenceCount, 0);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("a declared manifest gives its cards a sourcePriority feature", async () => {
    const described = recordingSource(DESCRIBED_MCP);

    // Authority is the only axis that differs: both sources are remote with
    // undeclared (hence `unknown`) freshness, so the order below follows the
    // authority declaration alone rather than the source that declared less.
    const mediumAuthority = recordingSource({
      id: "manifest-test:no-priority",
      kind: "native",
      read: ["semantic_search"],
      authority: { level: "medium" },
      cost: { class: "remote" },
    });

    const disposers = [
      registerContextSource(described.source),
      registerContextSource(mediumAuthority.source),
    ];

    try {
      const result = await searchContext(QUERY);

      // Cost and freshness are held equal (remote / undeclared), so the order
      // follows authority alone: `low` must not outrank `medium`. Inverting
      // the priority weights must not flip this assertion while cost and
      // freshness agree.
      const priorities = new Map(
        result.ranking.map((entry) => [entry.sourceId, entry.features.sourcePriority]),
      );

      const mediumPriority = priorities.get(mediumAuthority.source.id);
      const describedPriority = priorities.get(described.source.id);

      assert.ok(mediumPriority !== undefined);
      assert.ok(describedPriority !== undefined);
      assert.ok(mediumPriority > describedPriority);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("isTrustedRetrievalSource — both halves are required", () => {
  test("a declared `unknown` authority is never promoted to trust", () => {
    // The remaining rows are proved behaviorally above: described sources are
    // selected as candidates, half-described ones fail at registration. This
    // pins the one case no selection path reaches — registration rejects
    // `unknown` before selection, so only the predicate can speak for it.
    assert.equal(
      isTrustedRetrievalSource({ ...NO_AUTHORITY, authority: { level: "unknown" } }),
      false,
    );
  });
});
