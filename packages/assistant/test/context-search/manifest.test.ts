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
 * Selection policy for the source capability manifest (ADR-0101 sub-decisions 14-16).
 * Selection never reads a source id, so each assertion is on what a source declares.
 * A source missing its read or authority declaration fails at registration, so those cases expect a throw.
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

/** A source that records whether it was read. "Skipped" must mean no reader ran. */
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
  mediaKinds: ["text"],
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
  mediaKinds: ["text"],
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
  mediaKinds: ["text"],
  availability: "unavailable",
};

/** Read semantics but no provenance: half a description is not a description. */
const NO_AUTHORITY: SourceManifest = {
  id: "manifest-test:no-authority",
  kind: "native",
  read: ["semantic_search"],
  mediaKinds: ["text"],
};

/** Deterministic lookups only — it cannot answer a free-text question. */
const EXACT_ONLY: RetrievalSourceManifest = {
  id: "manifest-test:exact-only",
  kind: "internal",
  read: ["exact_lookup"],
  authority: { level: "high" },
  mediaKinds: ["text"],
};

/** Exact lookups plus expansion, so it must never get the `expansion-only` reason. */
const EXACT_AND_EXPAND: RetrievalSourceManifest = {
  id: "manifest-test:exact-and-expand",
  kind: "internal",
  read: ["exact_lookup", "expand"],
  expansionKinds: ["test_record"],
  authority: { level: "high" },
  mediaKinds: ["text"],
};

const QUERY: ContextSearchRequest = {
  userId: "user-1",
  query: "anything",
  // No expander is registered, so the expansion phase routes nothing.
  expand: true,
  // Every source is affordable, so these assertions are about read capability alone.
  maxSourceCost: "remote",
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
    // Trust follows the declaration, not the author: `kind` never appears in the selection.
    const selection = select([DESCRIBED_MCP]);

    assert.equal(selection.size, 0);
  });

  test("a source that forgets its read declaration fails at registration, not at read time", () => {
    // SAFETY: intentionally registers a catalog-loose manifest to prove the retrieval boundary rejects it at boot.
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
    // Registration rejects a half-described source, so a missing authority stops the boot.
    // `mediaKinds` is set so the missing authority is the only reason to throw.
    // SAFETY: intentionally registers a catalog-loose manifest to prove the retrieval boundary rejects it at boot.
    const manifest = NO_AUTHORITY as RetrievalSourceManifest;

    assert.throws(
      () =>
        registerContextSource({
          id: manifest.id,
          manifest,
          reads: { semantic_search: async () => ({ evidence: [] }) },
        }),
      /authority/,
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

  test("an exact-lookup source that also expands is no-answering-read, not expansion-only, for a query with no object", () => {
    // This source also does exact lookups, so `expansion-only` would misdescribe it.
    const selection = select([EXACT_AND_EXPAND]);

    assert.equal(reasonFor(selection, EXACT_AND_EXPAND.id), "no-answering-read");
  });

  test("the same expanding exact-lookup source is a candidate once the request declares an object", () => {
    const selection = select([EXACT_AND_EXPAND], {
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

      // `skipped` is its own status: "never asked" must not read as "asked and found nothing".
      assert.equal(report?.status, "skipped");
      assert.equal(report?.status === "skipped" ? report.reason : undefined, "unavailable");
      assert.equal(report?.evidenceCount, 0);
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  test("a declared manifest gives its cards a sourcePriority feature", async () => {
    const described = recordingSource(DESCRIBED_MCP);

    // Authority is the only axis that differs: both are remote with undeclared freshness.
    const mediumAuthority = recordingSource({
      id: "manifest-test:no-priority",
      kind: "native",
      read: ["semantic_search"],
      authority: { level: "medium" },
      mediaKinds: ["text"],
      cost: { class: "remote" },
    });

    const disposers = [
      registerContextSource(described.source),
      registerContextSource(mediumAuthority.source),
    ];

    try {
      const result = await searchContext(QUERY);

      // Cost and freshness are equal, so `low` must not outrank `medium`.
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
    // Registration rejects `unknown` before selection, so only the predicate covers that case.
    assert.equal(
      isTrustedRetrievalSource({ ...NO_AUTHORITY, authority: { level: "unknown" } }),
      false,
    );
  });
});
