import { isRecord } from "./guards";

/**
 * Cap runaway strings in tool results. The whole transcript replays every turn.
 * The cap is high on purpose: a clipped private read (Gmail, private repo) cannot
 * be recovered, and a 2K cap made the model chase the tail on the public web.
 * Deterministic, so the cached transcript prefix stays stable.
 */

/** Above the largest measured `github.get_issue` body (~6.3K), so normal reads never clip. */
export const TOOL_RESULT_MAX_STRING_CHARS = 8000;

export interface BoundResult {
  value: unknown;
  clipped: number;
}

/** The notice tells the model the body is incomplete. */
function clipString(s: string, max: number) {
  if (s.length <= max) return { value: s, clipped: 0 };
  const clipped = s.length - max;

  return {
    value: `${s.slice(0, max)}\n…[truncated ${clipped} chars — re-fetch or paginate this tool for the full content]`,
    clipped,
  };
}

/**
 * Recursively clip long strings. Returns the same value when nothing clips.
 * Leaves class instances (Date, Map) alone.
 */
export function boundToolResult(
  value: unknown,
  maxStringChars: number = TOOL_RESULT_MAX_STRING_CHARS,
): BoundResult {
  if (typeof value === "string") {
    return clipString(value, maxStringChars);
  }

  if (Array.isArray(value)) {
    let clipped = 0;
    let changed = false;

    const out = value.map((item) => {
      const r = boundToolResult(item, maxStringChars);
      clipped += r.clipped;

      if (r.value !== item) changed = true;

      return r.value;
    });

    return { value: changed ? out : value, clipped };
  }

  if (isRecord(value)) {
    let clipped = 0;
    let changed = false;
    const out: Record<string, unknown> = {};

    for (const [key, v] of Object.entries(value)) {
      const r = boundToolResult(v, maxStringChars);
      clipped += r.clipped;

      if (r.value !== v) changed = true;
      out[key] = r.value;
    }

    return { value: changed ? out : value, clipped };
  }

  return { value, clipped: 0 };
}
