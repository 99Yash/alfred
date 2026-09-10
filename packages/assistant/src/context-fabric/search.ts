import { toMessage } from "@alfred/contracts";
import { contextSearchRequestSchema } from "./contracts";
import { listContextSources } from "./registry";
import type { ContextEvidence, ContextSearchResult, ContextSourceReport } from "./types";

/**
 * Read-only evidence search across every registered Context Fabric source.
 *
 * This is the boundary's one verb. With no source registered — the state at
 * this slice — it returns an empty, typed result rather than throwing, so a
 * caller degrades honestly before any adapter exists. A source that throws
 * becomes one `error` report; it never fails the whole search, and absence
 * never closes a loop.
 *
 * Ranking is deliberately absent here: cards come back in source-registration
 * order and are truncated to the request `limit`. The deterministic ranker
 * lands in #427.
 */
export async function searchContext(request: unknown): Promise<ContextSearchResult> {
  const parsed = contextSearchRequestSchema.parse(request);
  const sources = listContextSources();

  if (sources.length === 0) {
    return { request: parsed, evidence: [], sources: [] };
  }

  const reports: ContextSourceReport[] = [];
  const collected: ContextEvidence[] = [];

  for (const source of sources) {
    try {
      const result = await source.search(parsed);

      reports.push({
        sourceId: source.id,
        status: result.evidence.length > 0 ? "ok" : "empty",
        evidenceCount: result.evidence.length,
      });
      collected.push(...result.evidence);
    } catch (error) {
      reports.push({
        sourceId: source.id,
        status: "error",
        evidenceCount: 0,
        reason: toMessage(error),
      });
    }
  }

  return {
    request: parsed,
    evidence: collected.slice(0, parsed.limit),
    sources: reports,
  };
}
