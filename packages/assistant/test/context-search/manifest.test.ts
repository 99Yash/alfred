import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isTrustedRetrievalSource,
  sourceManifestDisplayName,
  sourceManifestDomains,
  type ContextSearchRequest,
  type EvidenceCard,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import {
  registerContextSource,
  searchContext,
  selectContextSources,
  type ContextSource,
} from "@alfred/assistant/context-search";

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
 * A source that records whether it was read. "Skipped" must mean the search
 * never ran, not that its output was discarded afterwards — the whole point of
 * excluding a source is not paying for it.
 */
function recordingSource(manifest: RetrievalSourceManifest) {
  let read = false;

  const source: ContextSource = {
    id: manifest.id,
    manifest,
    async search() {
      read = true;

      return { evidence: [cardFrom(manifest.id)] };
    },
  };

  return { source, wasRead: () => read };
}

const NATIVE: RetrievalSourceManifest = {
  id: "manifest-test:native",
  kind: "native",
  integration: "github",
  read: ["semantic_search", "exact_lookup"],
  identityKeys: ["github_login"],
  objectKinds: ["pull_request"],
  freshness: { typical: "live", windowMinutes: 15 },
  indexability: "live_only",
  authority: { level: "high", label: "GitHub App" },
  cost: { class: "remote", typicalLatencyMs: 400 },
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

const QUERY: ContextSearchRequest = { userId: "user-1", query: "anything", limit: 10 };

function select(
  manifests: readonly RetrievalSourceManifest[],
  request: ContextSearchRequest = QUERY,
) {
  const sources = manifests.map((manifest) => recordingSource(manifest).source);

  return selectContextSources(sources, request);
}

function reasonFor(selection: ReturnType<typeof select>, sourceId: string): string | undefined {
  return selection.excluded.find((one) => one.sourceId === sourceId)?.reason;
}

describe("selectContextSources — who gets asked", () => {
  test("a fully described native source is a candidate", () => {
    const selection = select([NATIVE]);

    assert.deepEqual(
      selection.candidates.map((source) => source.id),
      [NATIVE.id],
    );
    assert.equal(selection.excluded.length, 0);
  });

  test("a described MCP source is a candidate on the same terms as a native one", () => {
    // Trust follows the declaration, not the author: `kind` never appears in
    // the selection, so a third-party server that declared its read semantics
    // and its provenance is asked exactly as a first-party source is.
    const selection = select([DESCRIBED_MCP]);

    assert.deepEqual(
      selection.candidates.map((source) => source.id),
      [DESCRIBED_MCP.id],
    );
  });

  test("a source that forgets its read declaration fails at registration, not at read time", () => {
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally registers a catalog-loose manifest to prove the retrieval boundary rejects it at boot.
    const manifest = UNDESCRIBED_MCP as RetrievalSourceManifest;

    assert.throws(() =>
      registerContextSource({
        id: manifest.id,
        manifest,
        async search() {
          return { evidence: [] };
        },
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
        async search() {
          return { evidence: [] };
        },
      }),
    );
  });

  test("a source that declares itself unavailable is excluded", () => {
    const selection = select([UNAVAILABLE]);

    assert.equal(selection.candidates.length, 0);
    assert.equal(reasonFor(selection, UNAVAILABLE.id), "source declares it is unavailable");
  });

  test("an exact-lookup source is skipped for a query that declares no object", () => {
    const selection = select([EXACT_ONLY]);

    assert.equal(selection.candidates.length, 0);
    assert.equal(
      reasonFor(selection, EXACT_ONLY.id),
      "source declares no read capability that answers this request",
    );
  });

  test("the same exact-lookup source is a candidate once the request declares an object", () => {
    const selection = select([EXACT_ONLY], {
      ...QUERY,
      objects: [{ by: "identity", provider: "github", kind: "pull_request", externalId: "1" }],
    });

    assert.deepEqual(
      selection.candidates.map((source) => source.id),
      [EXACT_ONLY.id],
    );
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
      assert.equal(report?.reason, "source declares it is unavailable");
      assert.equal(report?.evidenceCount, 0);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("a declared manifest gives its cards a sourcePriority feature", async () => {
    const described = recordingSource(DESCRIBED_MCP);

    const silent = recordingSource({
      id: "manifest-test:no-priority",
      kind: "native",
      read: ["semantic_search"],
      authority: { level: "medium" },
    });

    const disposers = [
      registerContextSource(described.source),
      registerContextSource(silent.source),
    ];

    try {
      const result = await searchContext(QUERY);

      // Both declared an authority, so both fold to a priority. The point of
      // the assertion is that the feature is PRESENT and ordered by the
      // declaration: `low` authority must not outrank `medium`.
      const priorities = new Map(
        result.ranking.map((entry) => [entry.sourceId, entry.features.sourcePriority]),
      );

      const silentPriority = priorities.get(silent.source.id);
      const describedPriority = priorities.get(described.source.id);

      assert.ok(silentPriority !== undefined);
      assert.ok(describedPriority !== undefined);
      assert.ok(silentPriority > describedPriority);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });
});

describe("a manifest reads its shared facts out of the integration registry", () => {
  test("a source that names an integration does not restate its name or domain", () => {
    // The non-duplication rule (#466 criterion 3): renaming an integration in
    // ADR-0093's record renames its source, because the source never copied it.
    assert.equal(sourceManifestDisplayName(NATIVE), "GitHub");
    assert.deepEqual(sourceManifestDomains(NATIVE), ["github.com"]);
  });

  test("a source that names no integration falls back to its own name, then its id", () => {
    assert.equal(sourceManifestDisplayName(DESCRIBED_MCP), "A described MCP server");
    assert.equal(sourceManifestDisplayName(UNDESCRIBED_MCP), UNDESCRIBED_MCP.id);
    assert.deepEqual(sourceManifestDomains(UNDESCRIBED_MCP), []);
  });
});

describe("isTrustedRetrievalSource — both halves are required", () => {
  test("silence is never promoted to trust", () => {
    assert.equal(isTrustedRetrievalSource(NATIVE), true);
    assert.equal(isTrustedRetrievalSource(DESCRIBED_MCP), true);
    assert.equal(isTrustedRetrievalSource(NO_AUTHORITY), false);
    assert.equal(isTrustedRetrievalSource(UNDESCRIBED_MCP), false);
    assert.equal(
      isTrustedRetrievalSource({ ...NO_AUTHORITY, authority: { level: "unknown" } }),
      false,
    );
  });
});
