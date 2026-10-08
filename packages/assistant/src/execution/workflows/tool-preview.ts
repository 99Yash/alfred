import { isRecord } from "@alfred/contracts";

/** The `chat.tool` schema cap; `publishEvent` throws on a longer preview. */
export const PREVIEW_CHARS = 2_000;

/** `[maxArrayItems, maxStringLen, maxObjectKeys]`, loosest first. The first tier that fits wins. */
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

export interface Preview {
  text: string;
  /**
   * A pruned preview still parses, so only this flag shows data was lost.
   * Pruning cuts sibling arrays to the same length, so equal lengths prove nothing.
   */
  truncated: boolean;
}

export function preview(value: unknown): Preview {
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

  // Prune so the preview stays valid JSON under the cap.
  try {
    for (const [maxArray, maxString, maxKeys] of PREVIEW_TIERS) {
      const pruned = JSON.stringify(pruneForPreview(value, maxArray, maxString, maxKeys)) ?? "";

      if (pruned && pruned.length <= PREVIEW_CHARS) return { text: pruned, truncated: true };
    }
  } catch {
    // fall through to the slice below
  }

  // Last resort: a slice that will not parse.
  return { text: `${full.slice(0, PREVIEW_CHARS - 1)}…`, truncated: true };
}
