import {
  humanizeSlug,
  sourceAuthorityFromManifest,
  sourceRefFromManifest,
  type ContextSearchRequest,
  type EvidenceCard,
  type RetrievalSourceManifest,
} from "@alfred/contracts";
import { recallMemory, type RecallMemoryHit } from "@alfred/assistant/knowledge";
import type { ContextSource, ContextSourceResult } from "./registry";
import { compareByScoreThenId, renderContent } from "./vector-source";

/**
 * The memory adapter (#424; epic #422; ADR-0101).
 *
 * It wraps `recallMemory` over `memory_chunks` — Alfred's *interpretation*
 * layer (distilled thread summaries, cold-start research, manual notes) — into
 * canonical `EvidenceCard`s. It is the counterpart to the document adapter over
 * raw ingested provider content: same vector primitive family, a different
 * trust story, which is why it is a separate source with its own id rather than
 * a filter on the document adapter.
 *
 * The read relies on `recallMemory`'s user-facing default (#1052): an
 * `extraction_run` chunk is operational bookkeeping about Alfred's own runs,
 * not something Alfred knows about the user, so it must never render as
 * "Memory". The exclusion lives in the recall candidate query, before top-K,
 * so a near telemetry chunk cannot displace a real memory hit.
 *
 * A memory hit carries no timestamp, so the card declares `ingested`
 * freshness and no instant. That is honest, not a gap to fill from metadata
 * the primitive did not return. The ranker (#427) reads what the card actually
 * holds and simply drops its `recency` feature here, so a memory card is never
 * ranked as infinitely old for saying nothing.
 * The ordering and content fallback are shared with the document adapter in
 * `vector-source.ts`.
 */

/**
 * What this source declares (#466): `medium` authority, one step below the
 * document corpus, and the gap is the whole reason the two are separate
 * sources: a memory chunk is Alfred's own DISTILLATION of a thread or a
 * research run, so it can be wrong in a way a verbatim provider record cannot.
 * It names no `integration`, because a memory chunk is Alfred's own writing
 * rather than any provider's record. Only the fields the boundary acts on are
 * declared; catalog-reserved fields stay unset.
 *
 * The manifest is the single owner of the id, kind, display name, source ref,
 * and authority: cards derive all of them from it, so the declaration and the
 * evidence cannot drift.
 */
const MEMORY_CONTEXT_SOURCE_MANIFEST: RetrievalSourceManifest = {
  id: "memory",
  kind: "internal",
  displayName: "Memory",
  read: ["semantic_search"],
  freshness: { typical: "ingested" },
  authority: { level: "medium", label: "Alfred's distilled note, not a primary record" },
  cost: { class: "metered" },
  availability: "available",
};

/** Build the memory context source over the real `@alfred/assistant/knowledge` verb. */
export function createMemoryContextSource(): ContextSource {
  return {
    id: MEMORY_CONTEXT_SOURCE_MANIFEST.id,
    manifest: MEMORY_CONTEXT_SOURCE_MANIFEST,
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
  const authority = sourceAuthorityFromManifest(MEMORY_CONTEXT_SOURCE_MANIFEST);

  return {
    id: `${MEMORY_CONTEXT_SOURCE_MANIFEST.id}:${hit.chunkId}`,
    source: sourceRefFromManifest(MEMORY_CONTEXT_SOURCE_MANIFEST),
    mediaKind: "text",
    // `writeMemoryChunk` requires non-empty content today, so the note guards a
    // persisted row that predates that rule, not an expected path.
    ...renderContent(hit.preview, "This memory chunk has no stored text."),
    score: hit.similarity,
    ...(authority !== undefined ? { authority } : {}),
    time: { freshness: "ingested" },
    citations: [{ label, locator: `memory chunk ${hit.chunkId}` }],
    expansion: {
      sourceId: MEMORY_CONTEXT_SOURCE_MANIFEST.id,
      kind: "memory_chunk",
      ref: hit.chunkId,
      hint: label,
    },
  };
}
