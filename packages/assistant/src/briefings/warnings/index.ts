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
import { placeProvenance, provenanceName, warningsProvenance, type Sourced } from "../provenance";
import type { FeedRead, RankedWarning } from "./feed";
import { readGdacs } from "./gdacs";
import { readSachet, sachetCovers, sachetDistrict, type SachetDistrict } from "./sachet";

/**
 * One deadline for all feed reads of a gather. It starts after the place read. A cold Sachet read
 * is about 100 CAP files at six at a time, so it can take most of this. When the deadline stops a
 * feed after its list read, the feed keeps what it read and counts the rest as unread.
 */
const WARNINGS_DEADLINE_MS = 30_000;

/**
 * How a provenance reason names each feed. `name`: the feed. `unit`: what a partial read could not
 * read.
 */
const FEED_LABEL = {
  gdacs: { name: "GDACS", unit: "events" },
  ndma_sachet: { name: "NDMA Sachet", unit: "alerts" },
} as const satisfies Record<OfficialWarningSource, { name: string; unit: string }>;

/**
 * The official warnings whose area contains the user's place on the briefing day (ADR-0117
 * decision 4). GDACS is read for every place. NDMA Sachet is read when the place is in India and
 * its district has an LGD code. The reader does not throw: a feed that fails is a `read_failed`
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
  const district = place.area === undefined ? null : sachetDistrict(place.area);

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
      failures.push(`The ${FEED_LABEL[source].name} read failed.`);
      continue;
    }

    const { unread, total } = result.value;
    const label = FEED_LABEL[source];

    readAny = true;
    found.push(...result.value.found);

    if (unread > 0) {
      failures.push(`${label.name}: ${unread} of ${total} ${label.unit} could not be read.`);
    }
  }

  const provenance = warningsProvenance({
    fallback: statement,
    coverageGap: coverageGap(place, district),
    failures,
  });

  if (!readAny) return { value: null, provenance };

  // `officialWarningSchema` gives `onset` in one UTC form, so the text order is the time order.
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
 * The sentence that says that Alfred read only GDACS for the place, or `null` when Alfred read
 * each feed that covers the place. GDACS covers every place. Only India has a national feed today
 * (NDMA Sachet), so a place in another known country has no gap: no feed could be read there.
 *
 * - No `area`: a `location` preference, or a geocode with no country. Alfred does not know the
 *   country, so it cannot know whether a national feed covers the place.
 * - A place in India with no Sachet district: the geocode gave no district, or LGD does not have
 *   the district that it gave.
 *
 * Each sentence holds one name inside `provenanceName`, so it fits the provenance bound.
 */
function coverageGap(place: Place, district: SachetDistrict | null): string | null {
  const name = provenanceName(place.label);

  if (place.area === undefined) {
    return `Alfred does not know the country of ${name}, so it read only the global GDACS feed and no national feed.`;
  }

  if (sachetCovers(place.area) && district === null) {
    return `Alfred has no NDMA Sachet district for ${name}, so it read only the global GDACS feed.`;
  }

  return null;
}
