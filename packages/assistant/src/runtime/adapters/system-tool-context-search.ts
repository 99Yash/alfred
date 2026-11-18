import {
  packEvidenceCards,
  searchContext as searchContextFromFabric,
} from "@alfred/assistant/context-search";
import { objectIdentitySchema, type EvidenceCard } from "@alfred/contracts";
import {
  itemEvidence,
  readResult,
  registerSystemToolContextSearchAdapter,
  type DeliveredItem,
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
    return readResult(
      {
        ok: true,
        text: packed.text,
        includedCount: packed.includedIds.length,
        omittedCount: packed.omittedCount,
        truncated: packed.truncated,
      },
      itemEvidence(
        packed.included.map(({ card, block }) => cardItem(card, block)),
        packed.truncated || packed.omittedCount > 0
          ? { truncated: true, returned: packed.included.length }
          : undefined,
      ),
    );
  },
};

/**
 * One included card in the evidence record. A card that IS a provider object names the object. A
 * chunk that only names an object is a row of its source. The item is the block the model read.
 */
function cardItem(card: EvidenceCard, block: string): DeliveredItem {
  const object =
    card.object?.relation === "is" ? objectIdentitySchema.safeParse(card.object).data : undefined;

  return {
    ref: object
      ? { kind: "object", object, depth: "hit" }
      : { kind: "record", store: card.source.id, id: card.id, depth: "hit" },
    item: block,
  };
}

let dispose: (() => void) | undefined;

export function registerSystemToolContextSearch(): void {
  dispose ??= registerSystemToolContextSearchAdapter(contextSearchAdapter);
}

export function unregisterSystemToolContextSearch(): void {
  dispose?.();
  dispose = undefined;
}
