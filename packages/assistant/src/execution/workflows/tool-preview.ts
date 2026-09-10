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
    return Object.entries(value)
      .slice(0, maxKeys)
      .reduce<Record<string, unknown>>((out, [k, v]) => {
        out[k] = pruneForPreview(v, maxArray, maxString, maxKeys);
        return out;
      }, {});
  }
  return value;
}

/**
 * One preview and whether producing it lost anything.
 *
 * `truncated` is the verdict this module owns and nothing downstream can
 * recompute. Every reader that parses a preview back into the record it came
 * from is reading a value that may have had strings shortened, arrays sliced,
 * and object keys dropped — and the result still parses, so no reader can tell
 * by looking. Pruning also cuts sibling arrays to the *same* length, which is
 * why an equal pair count proves nothing about completeness. A reader that
 * needs the whole record checks this flag and falls back.
 */
export interface Preview {
  text: string;
  /** A string was shortened, an array sliced, or an object key dropped. */
  truncated: boolean;
}

export function preview(value: unknown): Preview {
  // Strings are plain text (error messages, model output) — slice directly.
  if (typeof value === "string") {
    return value.length > PREVIEW_CHARS
      ? { text: `${value.slice(0, PREVIEW_CHARS - 1)}…`, truncated: true }
      : { text: value, truncated: false };
  }
  let full: string;
  try {
    full = JSON.stringify(value) ?? "";
  } catch {
    full = String(value);
  }
  if (full.length <= PREVIEW_CHARS) return { text: full, truncated: false };

  // Over budget: prune the structure, tightening tier by tier, so the preview
  // stays *valid JSON* under the cap. The `chat.tool` event schema caps
  // previews at PREVIEW_CHARS and `publishEvent` throws on overflow, so we must
  // land under it. Reaching here at all means the value did not fit, so every
  // return below is truncated.
  try {
    for (const [maxArray, maxString, maxKeys] of PREVIEW_TIERS) {
      const pruned = JSON.stringify(pruneForPreview(value, maxArray, maxString, maxKeys)) ?? "";
      if (pruned && pruned.length <= PREVIEW_CHARS) return { text: pruned, truncated: true };
    }
  } catch {
    // fall through to the slice below
  }
  // Even the tightest tier overflowed (or pruning threw) — last resort is a
  // slice, accepting that this rare preview won't parse. Reserve a char for the
  // ellipsis.
  return { text: `${full.slice(0, PREVIEW_CHARS - 1)}…`, truncated: true };
}
