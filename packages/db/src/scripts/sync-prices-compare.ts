/**
 * Change detection for `sync-prices`.
 * `jsonb` reorders object keys, so a stored row never `JSON.stringify`-equals a fresh one.
 */
import { canonicalJson, isRecord } from "@alfred/contracts";

/** The prices held in columns, not in `metadata`. */
export interface ComparablePrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cachedInputPerMtok: number | null;
  cacheWriteInputPerMtok: number | null;
  perCallUsd: number | null;
  contextWindow: number | null;
}

export function pricesEqual(a: ComparablePrice, b: ComparablePrice): boolean {
  return (
    a.inputPerMtok === b.inputPerMtok &&
    a.outputPerMtok === b.outputPerMtok &&
    a.cachedInputPerMtok === b.cachedInputPerMtok &&
    a.cacheWriteInputPerMtok === b.cacheWriteInputPerMtok &&
    a.perCallUsd === b.perCallUsd &&
    a.contextWindow === b.contextWindow
  );
}

/**
 * Compare the audited `metadata` fields, so a tier or capability change adds a row.
 * Keep `canonicalJson`. `JSON.stringify` would see a change on every row, every run.
 */
export function auditedMetadataEqual(
  latestMetadata: unknown,
  incoming: Record<string, unknown> | undefined,
): boolean {
  const pick = (meta: unknown) => {
    const metadata = isRecord(meta) ? meta : {};
    const caps = isRecord(metadata.capabilities) ? metadata.capabilities : {};

    return canonicalJson({
      pricing: metadata.pricing ?? null,
      reasoningOptions: caps.reasoningOptions ?? null,
      temperature: caps.temperature ?? null,
    });
  };

  return pick(latestMetadata) === pick(incoming);
}
