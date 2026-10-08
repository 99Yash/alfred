import {
  packEvidenceCards,
  searchContext as searchContextFromFabric,
} from "@alfred/assistant/context-search";
import {
  registerSystemToolContextSearchAdapter,
  type SystemToolContextSearchAdapter,
} from "@alfred/assistant/tool-runtime";
import { logger } from "@alfred/logging";

/**
 * The `SystemToolContextSearchAdapter` (ADR-0101): runs `searchContext` for the
 * caller's user and returns packed text plus truncation facts, never raw cards.
 * Lives in composition because `context-search` pulls the DB and corpus graphs,
 * which the tool-runtime barrel must not import (ADR-0089).
 */
const contextSearchAdapter: SystemToolContextSearchAdapter = {
  async runContextSearch({ input, context }) {
    const result = await searchContextFromFabric({
      userId: context.userId,
      query: input.query,
      ...(input.task !== undefined ? { task: input.task } : {}),
      ...(input.objects !== undefined ? { objects: input.objects } : {}),
      limit: input.limit,
    });

    const packed = packEvidenceCards(result);

    // The only production reader of `ranking` (#427). A debug log keeps it out of the prompt.
    logger.debug(
      {
        event: "context_search_ranked",
        ranking: result.ranking.map((entry) => ({
          cardId: entry.cardId,
          sourceId: entry.sourceId,
          score: entry.score,
          features: entry.features,
        })),
      },
      "Context search ranked evidence",
    );

    // A source failure arrives as a note in the text, not as a throw.
    return {
      ok: true,
      text: packed.text,
      includedCount: packed.includedIds.length,
      omittedCount: packed.omittedCount,
      truncated: packed.truncated,
    };
  },
};

let dispose: (() => void) | undefined;

export function registerSystemToolContextSearch(): void {
  dispose ??= registerSystemToolContextSearchAdapter(contextSearchAdapter);
}

export function unregisterSystemToolContextSearch(): void {
  dispose?.();
  dispose = undefined;
}
