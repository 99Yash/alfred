import { db } from "@alfred/db";
import { modelPrices } from "@alfred/db/schemas";
import { modelPricingMetadataSchema, type ModelPriceTier } from "@alfred/contracts/model-pricing";
import type { LanguageModel } from "ai";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { identifyLanguageModel } from "../models";
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
  cacheWriteInputPerMtok: number | null;
  cacheWrite1hPerMtok: number | null;
  tiers: readonly ModelPriceTier[];
  perCallUsd: number | null;
  contextWindow: number | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedPrice>();

export interface PriceLookup {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  cacheWriteInputPerMtok: number | null;
  /** Provider-specific 1h cache-write rate; null when TTL does not affect pricing. */
  cacheWrite1hPerMtok: number | null;
  /** Higher token rates activated when a request crosses a provider context threshold. */
  tiers: readonly ModelPriceTier[];
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

function parsePricingMetadata(metadata: unknown) {
  const parsed = z
    .object({ pricing: modelPricingMetadataSchema.optional() })
    .passthrough()
    .safeParse(metadata);
  return parsed.success
    ? (parsed.data.pricing ?? { cacheWrite1hPerMtok: null, tiers: [] })
    : { cacheWrite1hPerMtok: null, tiers: [] };
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
  const pricing = parsePricingMetadata(row.metadata);
  return {
    inputPerMtok: Number(row.inputPerMtok),
    outputPerMtok: Number(row.outputPerMtok),
    cachedInputPerMtok: row.cachedInputPerMtok != null ? Number(row.cachedInputPerMtok) : null,
    cacheWriteInputPerMtok:
      row.cacheWriteInputPerMtok != null ? Number(row.cacheWriteInputPerMtok) : null,
    cacheWrite1hPerMtok: pricing.cacheWrite1hPerMtok,
    tiers: pricing.tiers,
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
      cacheWriteInputPerMtok: cached.cacheWriteInputPerMtok,
      cacheWrite1hPerMtok: cached.cacheWrite1hPerMtok,
      tiers: cached.tiers,
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
 * Provider id normalization is handled by `identifyLanguageModel` (shared with
 * the metering wrappers): AI SDK exposes namespaced ids
 * (`google.generative-ai`, `anthropic.messages`), models.dev uses the head
 * (`google`, `anthropic`).
 */
export async function resolveModelContextWindow(model: LanguageModel): Promise<number> {
  const { provider, modelId } = identifyLanguageModel(model);
  const price = await getPrice(provider, modelId);
  if (!price || price.contextWindow == null) {
    throw new Error(
      `[metering] no context_window for ${provider}/${modelId} — run \`pnpm --filter @alfred/db db:sync-prices\` to refresh model_prices.`,
    );
  }
  return price.contextWindow;
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
  // add cache reads and writes at their own rates — otherwise either category
  // is charged twice (full rate via the total, plus its cache rate).
  const rates = resolveRates(price, usage.inputTokens ?? 0);
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const uncachedInputTokens =
    usage.noCacheInputTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens - cacheWriteInputTokens);
  const uncachedInput = uncachedInputTokens / 1_000_000;
  const cachedInput = cachedInputTokens / 1_000_000;
  const cacheWriteInput = cacheWriteInputTokens / 1_000_000;
  const output = (usage.outputTokens ?? 0) / 1_000_000;
  const cachedRate = rates.cachedInputPerMtok ?? rates.inputPerMtok;
  const cacheWriteRate =
    usage.cacheWriteTtl === "1h" && rates.cacheWrite1hPerMtok != null
      ? rates.cacheWrite1hPerMtok
      : (rates.cacheWriteInputPerMtok ?? rates.inputPerMtok);
  return (
    uncachedInput * rates.inputPerMtok +
    cachedInput * cachedRate +
    cacheWriteInput * cacheWriteRate +
    output * rates.outputPerMtok
  );
}

function resolveRates(
  price: PriceLookup,
  inputTokens: number,
): Omit<PriceLookup, "contextWindow" | "tiers" | "perCallUsd"> {
  const tier = [...price.tiers]
    .sort((a, b) => b.minInputTokens - a.minInputTokens)
    .find((candidate) => inputTokens > candidate.minInputTokens);
  return tier ?? price;
}

/** Test-only: drop the cache so the next lookup refetches. */
export function _resetPriceCacheForTests(): void {
  cache.clear();
}
