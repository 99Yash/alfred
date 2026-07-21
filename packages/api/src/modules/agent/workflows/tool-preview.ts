import { isRecord } from "@alfred/contracts";

/**
 * Char budget for a tool argument/result preview. The `chat.tool` event schema
 * caps `argsPreview`/result previews at this length and `publishEvent` throws on
 * overflow, so every preview must land under it. Shared by the streaming tool
 * card (`stream-model-turn`) and the dispatch step's result previews so both
 * channels stay under the same wire cap.
 */
export const PREVIEW_CHARS = 2_000;

/**
 * Pruning tiers tried loosest-first when a structured preview overflows
 * {@link PREVIEW_CHARS}: `[maxArrayItems, maxStringLen, maxObjectKeys]`. The first
 * tier whose serialization fits is used, so previews shrink only as much as
 * the cap demands. The tightest tier exists so even a pathologically wide
 * result still lands under the cap as valid JSON.
 */
const PREVIEW_TIERS: ReadonlyArray<readonly [number, number, number]> = [
  [5, 300, 64],
  [3, 160, 48],
  [2, 80, 32],
  [1, 40, 16],
];

function pruneForPreview(
  value: unknown,
  maxArray: number,
  maxString: number,
  maxKeys: number,
): unknown {
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString - 1)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((v) => pruneForPreview(v, maxArray, maxString, maxKeys));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, maxKeys)) {
      out[k] = pruneForPreview(v, maxArray, maxString, maxKeys);
    }
    return out;
  }
  return value;
}

export function preview(value: unknown): string {
  // Strings are plain text (error messages, model output) — slice directly.
  if (typeof value === "string") {
    return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS - 1)}…` : value;
  }
  let full: string;
  try {
    full = JSON.stringify(value) ?? "";
  } catch {
    full = String(value);
  }
  if (full.length <= PREVIEW_CHARS) return full;

  // Over budget: prune the structure, tightening tier by tier, so the preview
  // stays *valid JSON* under the cap. The `chat.tool` event schema caps
  // previews at PREVIEW_CHARS and `publishEvent` throws on overflow, so we must
  // land under it.
  try {
    for (const [maxArray, maxString, maxKeys] of PREVIEW_TIERS) {
      const pruned = JSON.stringify(pruneForPreview(value, maxArray, maxString, maxKeys)) ?? "";
      if (pruned && pruned.length <= PREVIEW_CHARS) return pruned;
    }
  } catch {
    // fall through to the slice below
  }
  // Even the tightest tier overflowed (or pruning threw) — last resort is a
  // slice, accepting that this rare preview won't parse. Reserve a char for the
  // ellipsis.
  return `${full.slice(0, PREVIEW_CHARS - 1)}…`;
}
