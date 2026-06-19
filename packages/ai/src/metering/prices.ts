import { db } from "@alfred/db";
import { modelPrices } from "@alfred/db/schemas";
import type { LanguageModel } from "ai";
import { and, desc, eq, lte } from "drizzle-orm";
import type { CallUsage } from "./types";

/**
 * In-process price cache. Keyed by `${provider}:${model}`; bounded TTL
 * so a `db:sync-prices` deploy reaches running workers within a few
 * minutes without restart. Misses fall through to a single fetch and
 * populate the cache.
 *
 * Picked over an SQL view + per-call query because pricing changes
 * monthly at most — the cache trades a tiny staleness window for
 * eliminating a DB round-trip per metered call.
 */
const TTL_MS = 5 * 60_000;

interface CachedPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  perCallUsd: number | null;
  contextWindow: number | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedPrice>();

export interface PriceLookup {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  perCallUsd: number | null;
  /**
   * Max input tokens the model accepts in a single request. Seeded by
   * `pnpm --filter @alfred/db db:sync-prices` from models.dev. `null`
   * for rows that don't carry a meaningful context window (e.g. Voyage
   * embeddings). Consumed by ADR-0035 compaction to derive the 60%
   * threshold; `resolveModelContextWindow` throws when it is missing
   * for a model the runtime needs to reason about.
   */
  contextWindow: number | null;
}

function cacheKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

async function fetchPrice(provider: string, model: string): Promise<PriceLookup | null> {
  const rows = await db()
    .select()
    .from(modelPrices)
    .where(
      and(
        eq(modelPrices.provider, provider),
        eq(modelPrices.model, model),
        lte(modelPrices.validFrom, new Date()),
      ),
    )
    .orderBy(desc(modelPrices.validFrom))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    inputPerMtok: Number(row.inputPerMtok),
    outputPerMtok: Number(row.outputPerMtok),
    cachedInputPerMtok: row.cachedInputPerMtok != null ? Number(row.cachedInputPerMtok) : null,
    perCallUsd: row.perCallUsd != null ? Number(row.perCallUsd) : null,
    contextWindow: row.contextWindow ?? null,
  };
}

export async function getPrice(provider: string, model: string): Promise<PriceLookup | null> {
  const key = cacheKey(provider, model);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return {
      inputPerMtok: cached.inputPerMtok,
      outputPerMtok: cached.outputPerMtok,
      cachedInputPerMtok: cached.cachedInputPerMtok,
      perCallUsd: cached.perCallUsd,
      contextWindow: cached.contextWindow,
    };
  }
  const fresh = await fetchPrice(provider, model);
  if (!fresh) return null;
  cache.set(key, { ...fresh, fetchedAt: Date.now() });
  return fresh;
}

/**
 * Resolve the input-token context window for an AI SDK `LanguageModel` via
 * the `model_prices.context_window` column. Throws when the row is
 * missing or carries a null context window — boot-time `verifyMeteringModels`
 * uses this to fail fast on misconfigured workers (ADR-0035 derives the
 * compaction threshold from this value; a silent fallback would mean
 * unbounded transcript growth).
 *
 * Provider id normalization mirrors `wrappers.modelIdsFor`: AI SDK exposes
 * namespaced ids (`google.generative-ai`, `anthropic.messages`), models.dev
 * uses the head (`google`, `anthropic`).
 */
export async function resolveModelContextWindow(model: LanguageModel): Promise<number> {
  const { provider, modelId } = identifyModel(model);
  const price = await getPrice(provider, modelId);
  if (!price || price.contextWindow == null) {
    throw new Error(
      `[metering] no context_window for ${provider}/${modelId} — run \`pnpm --filter @alfred/db db:sync-prices\` to refresh model_prices.`,
    );
  }
  return price.contextWindow;
}

function identifyModel(model: LanguageModel): { provider: string; modelId: string } {
  if (typeof model === "object" && model && "provider" in model && "modelId" in model) {
    const raw = String(model.provider);
    const head = raw.split(".")[0] ?? raw;
    return { provider: head, modelId: String(model.modelId) };
  }
  return { provider: "unknown", modelId: String(model) };
}

/**
 * Compute USD cost from a known price + token usage. Returns 0 when the
 * price row is missing — the log row still lands so we can detect the
 * gap and run `db:sync-prices`. (Silent zero is preferable to throwing,
 * which would break the underlying call path.)
 */
export function computeCost(price: PriceLookup | null, usage: CallUsage | undefined): number {
  if (!price) return 0;
  if (price.perCallUsd != null) return price.perCallUsd;
  if (!usage) return 0;
  // The SDK's `inputTokens` is the TOTAL prompt, INCLUDING cache reads
  // (anthropic/google both report total = uncached + cache_creation +
  // cache_read). Bill only the uncached remainder at the full input rate, then
  // add cache reads at the cached rate — otherwise cache reads are charged
  // twice (full rate via the total, plus the cached rate). Cache-creation
  // (write) tokens, lacking a dedicated price column, fall into the uncached
  // remainder and are billed at the plain input rate.
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens) / 1_000_000;
  const cachedInput = cachedInputTokens / 1_000_000;
  const output = (usage.outputTokens ?? 0) / 1_000_000;
  const cachedRate = price.cachedInputPerMtok ?? price.inputPerMtok;
  return (
    uncachedInput * price.inputPerMtok + cachedInput * cachedRate + output * price.outputPerMtok
  );
}

/** Test-only: drop the cache so the next lookup refetches. */
export function _resetPriceCacheForTests(): void {
  cache.clear();
}
