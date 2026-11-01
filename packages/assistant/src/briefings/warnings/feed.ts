import {
  collapseWhitespace,
  httpErrorFromResponse,
  type OfficialWarning,
  type OfficialWarningSource,
} from "@alfred/contracts";

/**
 * One request to a feed. It is a third of the gather deadline (`WARNINGS_DEADLINE_MS`, 30 s, in
 * `index.ts`), so one slow request leaves time for the reads after it, such as the GDACS area reads
 * after the event list. The gather's deadline also stops it.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Some government servers refuse a request with no agent name. */
const USER_AGENT = "Alfred-briefing/1.0 (personal assistant; official warnings read)";

/**
 * A GET to a public feed. A status that is not 2xx throws an `HttpError`. A 204 is a response
 * with no body, and the caller decides what it means.
 */
export async function fetchFeed(
  url: URL,
  source: OfficialWarningSource,
  signal: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]),
  });

  if (!res.ok) throw await httpErrorFromResponse(source, res);

  return res;
}

/** A warning and its rank among all feeds: 0 is the most severe. */
export interface RankedWarning {
  readonly warning: OfficialWarning;
  readonly rank: number;
}

/**
 * What one feed gave. `unread`: the items of the feed that Alfred could not read (a GDACS event, or
 * one Sachet alert), out of `total`. An item counts when its request failed, when its body was not
 * readable, when the feed did not give a value that the match needs, when Alfred did not request
 * it, or when the deadline stopped its read. A list that is over its page bound counts one item
 * for the rest, because their number is not known. A feed whose list read failed throws instead.
 */
export interface FeedRead {
  readonly found: readonly RankedWarning[];
  readonly unread: number;
  readonly total: number;
}

/**
 * The text inside `max` UTF-16 units, so a zod `.max(max)` bound (which counts code points, never
 * more than units) accepts it. A cut does not leave half of a surrogate pair.
 */
export function clipText(text: string, max: number): string {
  const trimmed = collapseWhitespace(text);

  if (trimmed.length <= max) return trimmed;

  let cut = trimmed.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);

  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);

  return `${cut}…`;
}

/** An instant as ISO text, or `null` for an unreadable value. */
export function isoInstant(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
