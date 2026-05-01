import { db } from "@alfred/db";
import { modelPrices } from "@alfred/db/schemas";
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
  fetchedAt: number;
}

const cache = new Map<string, CachedPrice>();

export interface PriceLookup {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  perCallUsd: number | null;
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
    };
  }
  const fresh = await fetchPrice(provider, model);
  if (!fresh) return null;
  cache.set(key, { ...fresh, fetchedAt: Date.now() });
  return fresh;
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
  const input = (usage.inputTokens ?? 0) / 1_000_000;
  const cachedInput = (usage.cachedInputTokens ?? 0) / 1_000_000;
  const output = (usage.outputTokens ?? 0) / 1_000_000;
  const cachedRate = price.cachedInputPerMtok ?? price.inputPerMtok;
  return input * price.inputPerMtok + cachedInput * cachedRate + output * price.outputPerMtok;
}

/** Test-only: drop the cache so the next lookup refetches. */
export function _resetPriceCacheForTests(): void {
  cache.clear();
}
