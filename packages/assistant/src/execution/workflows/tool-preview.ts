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
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the prune walk returns its unknown input cut to size; the shape is the input's, and the only reader is `JSON.stringify`.
): unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the walk dispatches on the runtime representation of an unknown tool output; the string arm is the leaf it cuts.
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString - 1)}…` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((v) => pruneForPreview(v, maxArray, maxString, maxKeys));
  }

  if (isRecord(value)) {
    return (
      Object.entries(value)
        .slice(0, maxKeys)
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the rebuild copies an unknown record key by key; its keys are the input's, so no narrower key type exists.
        .reduce<Record<string, unknown>>((out, [k, v]) => {
          out[k] = pruneForPreview(v, maxArray, maxString, maxKeys);

          return out;
        }, {})
    );
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a string tool output is shown as is, not as a JSON-quoted string; any other value goes through `JSON.stringify`.
  if (typeof value === "string") {
    return value.length > PREVIEW_CHARS
      ? { text: `${value.slice(0, PREVIEW_CHARS - 1)}…`, truncated: true }
      : { text: value, truncated: false };
  }

  let full: string;

  try {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- lib.d.ts types JSON.stringify as string, but it returns undefined for undefined, a function, or a symbol.
    full = JSON.stringify(value) ?? "";
  } catch {
    full = String(value);
  }

  if (full.length <= PREVIEW_CHARS) return { text: full, truncated: false };

  // Prune so the preview stays valid JSON under the cap.
  try {
    for (const [maxArray, maxString, maxKeys] of PREVIEW_TIERS) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- lib.d.ts types JSON.stringify as string, but it returns undefined for undefined, a function, or a symbol.
      const pruned = JSON.stringify(pruneForPreview(value, maxArray, maxString, maxKeys)) ?? "";

      if (pruned && pruned.length <= PREVIEW_CHARS) return { text: pruned, truncated: true };
    }
  } catch {
    // fall through to the slice below
  }

  // Last resort: a slice that will not parse.
  return { text: `${full.slice(0, PREVIEW_CHARS - 1)}…`, truncated: true };
}
