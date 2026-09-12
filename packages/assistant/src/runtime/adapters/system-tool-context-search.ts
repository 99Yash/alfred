import {
  packEvidenceCards,
  searchContext as searchContextFromFabric,
} from "@alfred/assistant/context-search";
import {
  registerSystemToolContextSearchAdapter,
  type SystemToolContextSearchAdapter,
} from "@alfred/assistant/tool-runtime";

/**
 * The runtime-composition implementation of the `SystemToolContextSearchAdapter`
 * seam (epic #422; ADR-0101).
 *
 * It is the one place that knows both halves of the model-facing read: the
 * `context-search` boundary's `searchContext` verb and its `packEvidenceCards`
 * renderer. The tool (`system.search_context`) forwards the model's bounded
 * envelope here; this adapter binds the call's `userId`, runs the read over
 * every registered source, and returns the packed, cited, bounded text — never
 * the raw cards, a full provider body, or a media byte. The read's truncation
 * facts ride alongside the text so the model can say it saw only part of the
 * evidence.
 *
 * It lives in runtime composition because importing `@alfred/assistant/context-search`
 * pulls the database and corpus graphs; the tool-runtime barrel every tool
 * declaration imports must stay free of them (ADR-0089). Composition installs
 * it at boot, beside the other `system-tool-*` adapters.
 */
const contextSearchAdapter: SystemToolContextSearchAdapter = {
  async searchContext({ input, context }) {
    const result = await searchContextFromFabric({
      userId: context.userId,
      query: input.query,
      ...(input.task !== undefined ? { task: input.task } : {}),
      ...(input.objects !== undefined ? { objects: input.objects } : {}),
      limit: input.limit,
    });

    const packed = packEvidenceCards(result);

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
