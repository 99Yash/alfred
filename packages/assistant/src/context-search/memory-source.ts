import { humanizeSlug, type ContextSearchRequest, type EvidenceCard } from "@alfred/contracts";
import {
  recallMemory,
  type RecallMemoryArgs,
  type RecallMemoryHit,
} from "@alfred/assistant/knowledge";
import type { ContextSource, ContextSourceResult } from "./registry";

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
 * The primitive is injected so a test can drive ranking and mapping without a
 * database; the default is the real verb.
 */

/** Stable manifest id for the memory-chunk adapter (#466). */
const MEMORY_CONTEXT_SOURCE_ID = "memory";

/** The retrieval verb this adapter wraps; injectable so tests need no DB. */
type MemoryRecall = (args: RecallMemoryArgs) => Promise<RecallMemoryHit[]>;

/**
 * Build the memory context source. `runRecall` defaults to the real
 * `@alfred/assistant/knowledge` verb; a test passes a fake.
 */
export function createMemoryContextSource(runRecall: MemoryRecall = recallMemory): ContextSource {
  return {
    id: MEMORY_CONTEXT_SOURCE_ID,
    async search(request: ContextSearchRequest): Promise<ContextSourceResult> {
      const hits = await runRecall({
        query: request.query,
        userId: request.userId,
        limit: request.limit,
      });

      const evidence = [...hits].sort(compareMemoryHits).map(memoryHitToEvidenceCard);

      return { evidence };
    },
  };
}

/**
 * Deterministic source-local order: highest similarity first, chunk id as the
 * tie-break. #427 owns cross-source ranking; this only keeps one adapter's
 * output stable.
 */
function compareMemoryHits(a: RecallMemoryHit, b: RecallMemoryHit): number {
  return b.similarity - a.similarity || a.chunkId.localeCompare(b.chunkId);
}

/**
 * Map one recall hit to a canonical card. The id is the chunk id, the citation
 * locates the chunk inside Alfred's own store (there is no public URL), and
 * the expansion handle points at the chunk for a later drill-down (#428).
 */
export function memoryHitToEvidenceCard(hit: RecallMemoryHit): EvidenceCard {
  const label = humanizeSlug(hit.kind);

  return {
    id: `${MEMORY_CONTEXT_SOURCE_ID}:${hit.chunkId}`,
    source: {
      id: MEMORY_CONTEXT_SOURCE_ID,
      kind: "internal",
      displayName: "Memory",
    },
    mediaKind: "text",
    ...renderSnippet(hit.preview),
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

/**
 * The card must carry content: snippet when the recalled chunk has text, an
 * honest note when it does not. `writeMemoryChunk` requires non-empty content
 * today, so the note is a guard against a persisted row that predates that
 * rule, not an expected path.
 */
function renderSnippet(preview: string): { snippet: string } | { note: string } {
  return preview.length > 0
    ? { snippet: preview }
    : { note: "This memory chunk has no stored text." };
}
