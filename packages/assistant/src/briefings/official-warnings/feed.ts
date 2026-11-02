import {
  collapseWhitespace,
  httpErrorFromResponse,
  OFFICIAL_WARNING_TEXT_MAX,
  officialWarningSchema,
  type OfficialWarning,
  type OfficialWarningSource,
} from "@alfred/contracts";
import { logger } from "@alfred/logging";

/**
 * One request to a feed. It is a third of the gather deadline (`OFFICIAL_WARNINGS_DEADLINE_MS`, 30 s, in
 * `index.ts`), so one slow request leaves time for the reads after it, such as the GDACS area reads
 * after the event list. The gather's deadline and the caller's cancel also stop it.
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

/**
 * The one rank scale of all feeds: a lower rank is more severe. A GDACS alert level and a CAP
 * severity of the same weight have the same rank: Red and `Extreme` are `extreme`, Orange and
 * `Severe` are `severe`.
 */
export const WARNING_RANK = {
  extreme: 0,
  severe: 1,
} as const;

export type WarningRank = (typeof WARNING_RANK)[keyof typeof WARNING_RANK];

/** A warning and its rank among all feeds. */
export interface RankedWarning {
  readonly warning: OfficialWarning;
  readonly rank: WarningRank;
}

/**
 * What one feed gave. `unread`: the items of the feed that Alfred could not read (a GDACS event, or
 * one Sachet alert), out of `total`. An item counts when its request failed, when its body was not
 * readable, when the feed did not give a value that the match needs, when its warning failed the
 * contract parse (`buildWarning`), when Alfred did not request it, or when the deadline or a cancel
 * stopped its read. A list that is over its page bound counts one item for the rest, because their number is
 * not known. A feed whose list read failed throws instead.
 */
export interface FeedRead {
  readonly found: readonly RankedWarning[];
  readonly unread: number;
  readonly total: number;
}

/**
 * The values of one warning as the feed gives them. `buildWarning` clips each text to its bound.
 * `onset` and `expires` are epoch milliseconds from a feed time schema (`capTime`, `gdacsTime`),
 * which gives only a time that `Date` can hold.
 */
export interface WarningFields {
  readonly source: OfficialWarningSource;
  readonly rank: WarningRank;
  readonly issuer: string;
  readonly event: string;
  readonly severity: string;
  readonly headline: string;
  readonly area: string;
  readonly onset: number;
  readonly expires: number;
  readonly url?: string;
}

/**
 * The result of `buildWarning`. `rejected`: the warning failed the contract parse, so the feed
 * counts its item in `unread`.
 */
export type WarningBuild =
  | { readonly kind: "warning"; readonly warning: RankedWarning }
  | { readonly kind: "rejected" };

/**
 * The warning that the gather stores, parsed with `officialWarningSchema`. A feed value that is
 * blank after the whitespace fold (an area of " ") fails the parse here. It does not fail the parse
 * of the stored gather later. A reject is a log line, and it does not throw.
 */
export function buildWarning(fields: WarningFields): WarningBuild {
  const parsed = officialWarningSchema.safeParse({
    source: fields.source,
    issuer: clipText(fields.issuer, OFFICIAL_WARNING_TEXT_MAX.issuer),
    event: clipText(fields.event, OFFICIAL_WARNING_TEXT_MAX.event),
    severity: clipText(fields.severity, OFFICIAL_WARNING_TEXT_MAX.severity),
    headline: clipText(fields.headline, OFFICIAL_WARNING_TEXT_MAX.headline),
    area: clipText(fields.area, OFFICIAL_WARNING_TEXT_MAX.area),
    onset: new Date(fields.onset).toISOString(),
    expires: new Date(fields.expires).toISOString(),
    ...(fields.url === undefined ? {} : { url: fields.url }),
  });

  if (!parsed.success) {
    logger.warn(
      { source: fields.source, issues: parsed.error.issues.slice(0, 3) },
      "[briefing.official-warnings] warning failed the contract parse; not kept",
    );

    return { kind: "rejected" };
  }

  return { kind: "warning", warning: { rank: fields.rank, warning: parsed.data } };
}

/**
 * The text inside `max` UTF-16 units, so a zod `.max(max)` bound (which counts code points, never
 * more than units) accepts it. A cut does not leave half of a surrogate pair.
 */
function clipText(text: string, max: number): string {
  const trimmed = collapseWhitespace(text);

  if (trimmed.length <= max) return trimmed;

  let cut = trimmed.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);

  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);

  return `${cut}…`;
}
