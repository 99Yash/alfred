import { humanizeSlug, type ContextSearchRequest, type EvidenceCard } from "@alfred/contracts";
import { recallMemory, type RecallMemoryHit } from "@alfred/assistant/knowledge";
import type { ContextSource, ContextSourceResult } from "./registry";
import { compareByScoreThenId, internalSourceRef, renderContent } from "./vector-source";

/**
 * The memory adapter (#424; epic #422; ADR-0101).
 *
 * It wraps `recallMemory` over `memory_chunks` — Alfred's *interpretation*
 * layer (distilled thread summaries, extraction runs, cold-start research) —
 * into canonical `EvidenceCard`s. It is the counterpart to the document
 * adapter over raw ingested provider content: same vector primitive family,
 * a different trust story, which is why it is a separate source with its own
 * id rather than a filter on the document adapter.
 *
 * A memory hit carries no timestamp, so the card declares `ingested`
 * freshness and no instant. That is honest, not a gap to fill from metadata
 * the primitive did not return; #427 ranks on what the card actually holds.
 * The ordering and content fallback are shared with the document adapter in
 * `vector-source.ts`.
 */

/** Stable manifest id for the memory-chunk adapter (#466). */
const MEMORY_CONTEXT_SOURCE_ID = "memory";

/** Build the memory context source over the real `@alfred/assistant/knowledge` verb. */
export function createMemoryContextSource(): ContextSource {
  return {
    id: MEMORY_CONTEXT_SOURCE_ID,
    async search(request: ContextSearchRequest): Promise<ContextSourceResult> {
      const hits = await recallMemory({
        query: request.query,
        userId: request.userId,
        limit: request.limit,
      });

      const evidence = [...hits].sort(compareByScoreThenId).map(memoryHitToEvidenceCard);

      return { evidence };
    },
  };
}

/**
 * Map one recall hit to a canonical card. The id is the chunk id, the citation
 * locates the chunk inside Alfred's own store (there is no public URL), and
 * the expansion handle points at the chunk for a later drill-down (#428).
 * `hit.kind` is a chunk kind, not an integration slug, so `humanizeSlug` is
 * the right display helper here (`thread_summary` → "Thread Summary").
 */
function memoryHitToEvidenceCard(hit: RecallMemoryHit): EvidenceCard {
  const label = humanizeSlug(hit.kind);

  return {
    id: `${MEMORY_CONTEXT_SOURCE_ID}:${hit.chunkId}`,
    source: internalSourceRef(MEMORY_CONTEXT_SOURCE_ID, "Memory"),
    mediaKind: "text",
    // `writeMemoryChunk` requires non-empty content today, so the note guards a
    // persisted row that predates that rule, not an expected path.
    ...renderContent(hit.preview, "This memory chunk has no stored text."),
    score: hit.similarity,
    time: { freshness: "ingested" },
    citations: [{ label, locator: `memory chunk ${hit.chunkId}` }],
    expansion: {
      sourceId: MEMORY_CONTEXT_SOURCE_ID,
      kind: "memory_chunk",
      ref: hit.chunkId,
      hint: label,
    },
  };
}
