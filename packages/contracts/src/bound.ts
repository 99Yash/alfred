import { isPlainRecord } from "./guards.js";

/**
 * Tool-result payload bounding — a runaway-payload GUARDRAIL (not the accrual
 * optimizer; see below).
 *
 * Every dispatched tool result is appended to the run transcript, and the whole
 * transcript is replayed to the model on **every** subsequent turn. Measurement
 * (dev, 2026-07-01) showed tool results are ~67% of transcript bytes, and the
 * bloat is concentrated in a few long free-text string fields — a
 * `github.get_issue` result is ~6.8KB of which ~6.5KB (95%) is the issue
 * `body`; a `system.await_sub_agent` result carries a 13KB report string.
 *
 * {@link boundToolResult} recursively caps any single string longer than
 * {@link TOOL_RESULT_MAX_STRING_CHARS}, replacing the tail with an explicit
 * truncation notice (so the model never treats a clipped body as complete —
 * same honesty posture as ADR-0070's `sanitized` notice). Short navigational
 * strings (titles, urls, numbers, snippets) pass through untouched. Applied
 * deterministically at transcript-append time, so a given result bounds to the
 * same bytes on every turn and the cached transcript prefix (#223) stays stable.
 *
 * WHY THE CAP IS HIGH (guardrail, not squeeze). A live Deep-tier run
 * (2026-07-01) proved an aggressive cap (~2K) is a net loss: the model saw the
 * truncation notice on a `github.get_issue` body and *compensated* with a
 * `web_search` + `fetch_url` to recover the tail — extra turns, and both fell
 * back to the PUBLIC web (dictionary junk + GitHub's unauth nav shell), so the
 * answer was still caveated. Crucially, Alfred's domain is PRIVATE data (Gmail
 * bodies, calendar, private repos): a clipped result there is unrecoverable —
 * no web fallback exists. So the cap must never bite a normal single-object
 * read; it only fires on genuinely pathological payloads (runaway file dumps,
 * oversized reports). Cutting the common-case accrual (many moderate reads
 * piling up across a long run) safely requires a RECENCY-PRESERVING bound —
 * keep the last N results full, squeeze only the older ones the model is done
 * with — which interacts with #223 caching and is tracked as a follow-up, not
 * done here.
 *
 * Web-safe (pure string/structural work, no Node APIs) so it lives in
 * `@alfred/contracts` beside {@link sanitizeToolResult} as the one shared
 * definition. Runs AFTER sanitize in the dispatch envelope.
 */

/**
 * Max characters kept for any single string field in a tool result before the
 * tail is clipped. Set well above a normal single-object read (the largest
 * measured `github.get_issue` body was ~6.3K) so the guardrail only trips on
 * pathological/runaway payloads — clipping a normal private-data read is
 * unrecoverable (see file header). Tunable single knob.
 */
export const TOOL_RESULT_MAX_STRING_CHARS = 8000;

/** The result of a bounding pass. */
export interface BoundResult {
  value: unknown;
  /** Total characters clipped across all strings (0 when nothing was bounded). */
  clipped: number;
}

/** Clip one string to `max` chars, appending a notice reporting the omitted count. */
function clipString(s: string, max: number): { value: string; clipped: number } {
  if (s.length <= max) return { value: s, clipped: 0 };
  const clipped = s.length - max;
  return {
    value: `${s.slice(0, max)}\n…[truncated ${clipped} chars — re-fetch or paginate this tool for the full content]`,
    clipped,
  };
}

/**
 * Recursively cap long string values in a tool result, returning the (possibly
 * new) value and the total characters clipped. Non-string scalars pass through.
 * The returned value is a *new* structure only when something was clipped; an
 * unbounded value is returned as-is (clean path allocates nothing). Exotic
 * objects (Date/Map/class instances) are left intact — tool results are
 * POJO/JSON shaped, mirroring {@link sanitizeToolResult}.
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
  if (isPlainRecord(value)) {
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
