import {
  OFFICIAL_WARNINGS_MAX,
  type IanaTimezone,
  type OfficialWarningSource,
  type Place,
  type WarningsContribution,
} from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { addDays, inZone, type LocalDateKey } from "@alfred/assistant/time";
import type { UserLocation } from "../../knowledge";
import { placeProvenance, warningsProvenance, type Sourced } from "../provenance";
import type { FeedRead, RankedWarning } from "./feed";
import { readGdacs } from "./gdacs";
import { readSachet, sachetDistrict } from "./sachet";

/**
 * One deadline for all feed reads of a gather. It starts after the place read. A cold Sachet read
 * is about 100 CAP files at six at a time, so it can take most of this. When the deadline stops a
 * feed after its list read, the feed keeps what it read and counts the rest as unread.
 */
const WARNINGS_DEADLINE_MS = 30_000;

/** The name of each feed in a provenance reason. */
const FEED_NAME = {
  gdacs: "GDACS",
  ndma_sachet: "NDMA Sachet",
} as const satisfies Record<OfficialWarningSource, string>;

/** What a partial read could not read, for each feed. */
const FEED_UNIT = {
  gdacs: "events",
  ndma_sachet: "alerts",
} as const satisfies Record<OfficialWarningSource, string>;

/**
 * The official warnings whose area contains the user's place on the briefing day (ADR-0117
 * decision 4). GDACS is read for every place. NDMA Sachet is read when the place is in India and
 * the geocode gave its district. The reader does not throw: a feed that fails is a `read_failed`
 * statement, and the value holds the feeds that Alfred read.
 */
export async function gatherWarningsContribution(args: {
  userId: string;
  located: UserLocation;
  timezone: IanaTimezone;
  briefingDate: LocalDateKey;
  now: Date;
}): Promise<Sourced<WarningsContribution | null>> {
  const { place, statement } = placeProvenance("warnings", args.located, args.timezone);

  if (place === null) return { value: null, provenance: [statement] };

  const signal = AbortSignal.timeout(WARNINGS_DEADLINE_MS);
  const zone = inZone(args.timezone);
  const dayStart = zone.startOf(args.briefingDate);
  const dayEnd = zone.startOf(addDays(args.briefingDate, 1));
  const district = place.area?.countryCode === "IN" ? sachetDistrict(place.area) : null;

  const reads: readonly (readonly [OfficialWarningSource, Promise<FeedRead>])[] = [
    ["gdacs", readGdacs({ place, dayStart, dayEnd, signal })],
    ...(district === null
      ? []
      : [["ndma_sachet", readSachet({ district, dayEnd, now: args.now, signal })] as const]),
  ];

  const settled = await Promise.allSettled(reads.map(([, read]) => read));
  let readAny = false;
  const found: RankedWarning[] = [];
  const failures: string[] = [];

  for (const [i, result] of settled.entries()) {
    const [source] = reads[i] ?? [];

    if (source === undefined) continue;

    if (result.status === "rejected") {
      logger.warn(
        { err: result.reason, userId: args.userId, source },
        "[briefing.warnings] feed read failed",
      );
      failures.push(`The ${FEED_NAME[source]} read failed.`);
      continue;
    }

    const { unread, total } = result.value;

    readAny = true;
    found.push(...result.value.found);

    if (unread > 0) {
      failures.push(
        `${FEED_NAME[source]}: ${unread} of ${total} ${FEED_UNIT[source]} could not be read.`,
      );
    }
  }

  const provenance = warningsProvenance({
    fallback: statement,
    coverageGap: coverageGap(place),
    failures,
  });

  if (!readAny) return { value: null, provenance };

  const ranked = found.toSorted(
    (a, b) => a.rank - b.rank || a.warning.onset.localeCompare(b.warning.onset),
  );

  if (ranked.length > OFFICIAL_WARNINGS_MAX) {
    logger.warn(
      { userId: args.userId, found: ranked.length, kept: OFFICIAL_WARNINGS_MAX },
      "[briefing.warnings] warnings over the stored bound; the least severe are dropped",
    );
  }

  return {
    value: {
      items: ranked.slice(0, OFFICIAL_WARNINGS_MAX).map(({ warning }) => warning),
    },
    provenance,
  };
}

/**
 * The sentence that says which feeds the place could not reach, or `null` when Alfred read each
 * feed that covers the place. Only India has a national feed today, so a place in another country
 * has no gap: GDACS is all that Alfred reads there.
 */
function coverageGap(place: Place): string | null {
  if (place.area === undefined) {
    return `Alfred has no country or district for ${place.label}, so it did not read a national warning feed.`;
  }

  if (place.area.countryCode === "IN" && place.area.district === undefined) {
    return `Alfred has no district for ${place.label}, so it did not read NDMA Sachet.`;
  }

  return null;
}
