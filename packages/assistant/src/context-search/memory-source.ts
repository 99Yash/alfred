import {
  humanizeSlug,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type BuiltInExpansionKind,
  type ContextSearchRequest,
  type EvidenceCard,
  type RetrievalSourceManifest,
  type SourceManifest,
} from "@alfred/contracts";
import { recallMemory, type RecallMemoryHit } from "@alfred/assistant/knowledge";
import { defineContextSource, type ContextSource } from "./registry";
import { compareByScoreThenId, renderContent } from "./vector-source";

/**
 * Memory source (#424, ADR-0101) over `recallMemory`: Alfred's own distilled
 * notes, not raw provider content. `recallMemory` already excludes
 * `extraction_run` chunks before top-K (#1052).
 * A hit has no timestamp, so the card has no instant and `recency` drops out.
 */

/** `medium` authority: a distillation can be wrong where a verbatim record cannot. */
const MEMORY_CONTEXT_SOURCE_ID = "memory";

const MEMORY_CONTEXT_SOURCE_MANIFEST_BASE: Omit<RetrievalSourceManifest, "id" | "read"> = {
  kind: "internal",
  displayName: "Memory",
  freshness: { typical: "ingested" },
  authority: { level: "medium", label: "Alfred's distilled note, not a primary record" },
  cost: { class: "metered" },
  availability: "available",
  // Prose Alfred wrote: no file, no page (#429).
  mediaKinds: ["text"],
};

function memoryManifest(): SourceManifest {
  return { ...MEMORY_CONTEXT_SOURCE_MANIFEST_BASE, id: MEMORY_CONTEXT_SOURCE_ID };
}

export function createMemoryContextSource(): ContextSource {
  return defineContextSource({
    id: MEMORY_CONTEXT_SOURCE_ID,
    manifest: MEMORY_CONTEXT_SOURCE_MANIFEST_BASE,
    reads: { semantic_search: readMemory },
  });
}

async function readMemory(request: ContextSearchRequest) {
  const hits = await recallMemory({
    query: request.query,
    userId: request.userId,
    limit: request.limit,
  });

  const evidence = [...hits].sort(compareByScoreThenId).map(memoryHitToEvidenceCard);

  return { evidence };
}

/**
 * One recall hit as a card. No public URL, so the locator names the chunk.
 * `hit.kind` is a chunk kind, so `humanizeSlug` fits (`thread_summary` -> "Thread Summary").
 */
function memoryHitToEvidenceCard(hit: RecallMemoryHit): EvidenceCard {
  const label = humanizeSlug(hit.kind);
  const authority = sourceAuthorityFromManifest(memoryManifest());

  return {
    id: `${MEMORY_CONTEXT_SOURCE_ID}:${hit.chunkId}`,
    source: sourceRefFromManifest(memoryManifest()),
    mediaKind: "text",
    // Guards old rows: `writeMemoryChunk` now rejects empty content.
    ...renderContent(hit.preview, "This memory chunk has no stored text."),
    score: hit.similarity,
    ...(authority !== undefined ? { authority } : {}),
    time: { freshness: "ingested" },
    citations: [{ label, locator: `memory chunk ${hit.chunkId}` }],
    expansion: {
      sourceId: MEMORY_CONTEXT_SOURCE_ID,
      kind: "memory_chunk" satisfies BuiltInExpansionKind,
      ref: hit.chunkId,
      hint: label,
    },
  };
}
