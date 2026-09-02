/**
 * Change detection for `sync-prices`. Pure and IO-free so it is testable
 * without running the sync itself.
 *
 * Both comparisons take one side that Postgres round-tripped and one side the
 * script just built. That asymmetry is the whole difficulty: `jsonb` does not
 * preserve object key order (it sorts keys by length, then bytewise), so the
 * stored form of `{cacheWrite1hPerMtok, tiers}` reads back as
 * `{tiers, cacheWrite1hPerMtok}`. Compare those with `JSON.stringify` and every
 * catalog row looks changed on every run.
 */
import { canonicalJson, isRecord } from "@alfred/contracts";

/** The pricing dimensions held in flat columns rather than in `metadata`. */
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
 * Compare pricing dimensions and the audited capability subset stored in
 * metadata. Folded into change detection so tier/TTL or capability changes
 * insert a fresh snapshot even when the flat columns are unchanged.
 *
 * `canonicalJson` sorts keys recursively, which makes the comparison immune to
 * the `jsonb` key reordering described above. Do not swap it for
 * `JSON.stringify`: that reintroduces a diff on every catalog row, and the
 * script then appends a full snapshot on every run and every predeploy.
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
