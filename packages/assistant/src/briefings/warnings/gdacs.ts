import { OFFICIAL_WARNING_TEXT_MAX, type Place } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { z } from "zod";
import { clipText, fetchFeed, isoInstant, type FeedRead, type RankedWarning } from "./feed";
import { areaGeometrySchema, containsPoint, distanceKm } from "./geometry";

/**
 * GDACS (Global Disaster Alert and Coordination System, UN and EU) as a warnings feed (ADR-0117
 * decision 4). It covers the large events in every country. Alfred reads only the Orange and Red
 * events, the API's own default: a Green event has a small expected impact, and the national feed
 * carries the local warnings.
 */

const GDACS_API = "https://www.gdacs.org/gdacsapi/api";

/**
 * The event types that Alfred reads. A drought (DR) is not read: it lasts for months, so it would
 * be an "at risk" item in every briefing.
 */
const GDACS_EVENT_TYPES = ["TC", "EQ", "FL", "VO", "WF"] as const;

type GdacsEventType = (typeof GDACS_EVENT_TYPES)[number];

const gdacsEventTypeSchema = z.enum(GDACS_EVENT_TYPES);

/**
 * The alert levels that the event list asks for. A Green event is not asked for, so any other
 * level in a reply is a feed fault: the event is skipped and counted as unreadable.
 */
const GDACS_ALERT_LEVELS = ["Red", "Orange"] as const;

type GdacsAlertLevel = (typeof GDACS_ALERT_LEVELS)[number];

/** The API gives at most 100 events in a page. */
const PAGE_SIZE = 100;

/** Orange and Red events in a few days are far fewer than five pages. More is a log line. */
const MAX_PAGES = 5;

/** Days before the briefing day that the event list reads, so a cyclone that started earlier is in it. */
const LIST_DAYS_BEFORE = 3;

/** Event areas that one gather reads. The nearest events go first. A drop is a log line. */
const MAX_AREA_READS = 20;

/**
 * The lowest shaking intensity (Modified Mercalli, from the GDACS ShakeMap polygons) that is a
 * warning: V, felt by nearly everyone, with objects that move. A lower intensity reaches far from
 * the epicentre and is not a risk.
 */
const EQ_MIN_INTENSITY = 5;

const eventSchema = z.object({
  geometry: z.object({ coordinates: z.array(z.number()).min(2) }),
  properties: z.object({
    eventtype: z.string(),
    eventid: z.number().int(),
    episodeid: z.number().int(),
    name: z.string().min(1),
    alertlevel: z.enum(GDACS_ALERT_LEVELS),
    fromdate: z.string(),
    todate: z.string(),
    country: z.string().optional(),
    source: z.string().optional(),
    url: z.object({ report: z.string().optional() }).optional(),
    severitydata: z.object({ severitytext: z.string().optional() }).optional(),
  }),
});

type GdacsEvent = z.infer<typeof eventSchema>;

const featureListSchema = z.object({ features: z.array(z.unknown()) });

const areaFeatureSchema = z.object({
  geometry: z.unknown(),
  properties: z.object({
    Class: z.string(),
    intensity: z.number().optional(),
    polygondate: z.string().optional(),
  }),
});

type AreaFeature = z.infer<typeof areaFeatureSchema>["properties"];

/**
 * The polygons that are the area of an event, for each type. The probe of 2026-11-01 found these
 * classes. Each other class (a track line, a 100 km circle around an epicentre, a river basin) is
 * not an area where the hazard is.
 *
 * - TC: the 60, 90, and 120 km/h wind buffers, and the uncertainty cone of the track.
 * - EQ: the ShakeMap intensity polygons at `EQ_MIN_INTENSITY` or more.
 * - FL: the affected area. `Poly_Global` is the whole basin.
 * - VO: the circle around the volcano.
 * - WF: the burned area.
 */
const EVENT_AREA = {
  TC: (f) => ["Poly_Green", "Poly_Orange", "Poly_Red", "Poly_Cones"].includes(f.Class),
  EQ: (f) => f.Class.startsWith("Poly_SMPInt") && (f.intensity ?? 0) >= EQ_MIN_INTENSITY,
  FL: (f) => f.Class === "Poly_Affected",
  VO: (f) => f.Class === "Poly_Circle",
  WF: (f) => f.Class === "Poly_area",
} as const satisfies Record<GdacsEventType, (feature: AreaFeature) => boolean>;

/** Red before Orange. */
const ALERT_RANK = {
  Red: 0,
  Orange: 1,
} as const satisfies Record<GdacsAlertLevel, number>;

/**
 * The GDACS events whose area contains the place, during the day `[dayStart, dayEnd)`. The test is
 * containment, with no distance band: on 2026-10-28 the nearest wind buffer of cyclone ARNAB-26
 * was 318 km from Bhubaneswar, and a band that wide selects much of a coast. The national feed
 * carries the district warnings.
 */
export async function readGdacs(args: {
  place: Place;
  dayStart: Date;
  dayEnd: Date;
  signal: AbortSignal;
}): Promise<FeedRead> {
  const events = await listEvents(args);

  const near = events
    .map((event) => ({ event, km: distanceKm(args.place, centroidOf(event)) }))
    .toSorted((a, b) => a.km - b.km);

  if (near.length > MAX_AREA_READS) {
    logger.warn(
      { events: near.length, read: MAX_AREA_READS },
      "[briefing.warnings] GDACS events over the read bound; the farthest are not read",
    );
  }

  const found: RankedWarning[] = [];
  let unread = 0;

  const reads = await Promise.allSettled(
    near.slice(0, MAX_AREA_READS).map(({ event }) => matchEvent(event, args)),
  );

  for (const [i, read] of reads.entries()) {
    if (read.status === "rejected") {
      unread += 1;
      logger.warn(
        { err: read.reason, eventId: near[i]?.event.properties.eventid },
        "[briefing.warnings] GDACS event area read failed",
      );
      continue;
    }

    if (read.value) found.push(read.value);
  }

  return { found, unread, total: Math.min(near.length, MAX_AREA_READS) };
}

async function listEvents(args: {
  dayStart: Date;
  dayEnd: Date;
  signal: AbortSignal;
}): Promise<GdacsEvent[]> {
  const from = new Date(args.dayStart.getTime() - LIST_DAYS_BEFORE * DAY_MS);
  const events: GdacsEvent[] = [];
  let skipped = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`${GDACS_API}/events/geteventlist/SEARCH`);
    url.searchParams.set("eventlist", GDACS_EVENT_TYPES.join(";"));
    url.searchParams.set("alertlevel", GDACS_ALERT_LEVELS.join(";"));
    url.searchParams.set("fromDate", utcDay(from));
    url.searchParams.set("toDate", utcDay(args.dayEnd));
    url.searchParams.set("pagenumber", String(page));

    const res = await fetchFeed(url, "gdacs", args.signal);

    // An empty page is a 204 with no body.
    if (res.status === 204) break;

    const { features } = featureListSchema.parse(await res.json());

    for (const feature of features) {
      const event = eventSchema.safeParse(feature);

      if (
        event.success &&
        gdacsEventTypeSchema.safeParse(event.data.properties.eventtype).success
      ) {
        events.push(event.data);
      } else {
        skipped += 1;
      }
    }

    if (features.length < PAGE_SIZE) break;

    if (page === MAX_PAGES) {
      logger.warn({ pages: MAX_PAGES }, "[briefing.warnings] GDACS event list over its page bound");
    }
  }

  if (skipped > 0) {
    logger.warn(
      { skipped },
      "[briefing.warnings] GDACS events with an unreadable shape or alert level skipped",
    );
  }

  return events;
}

/** The event as a warning when its area contains the place during the day, else `null`. */
async function matchEvent(
  event: GdacsEvent,
  args: { place: Place; dayStart: Date; dayEnd: Date; signal: AbortSignal },
): Promise<RankedWarning | null> {
  const { properties: p } = event;
  const type = gdacsEventTypeSchema.parse(p.eventtype);
  const start = gdacsTime(p.fromdate);

  // The event started after the day: it does not touch it.
  if (!Number.isFinite(start) || start >= args.dayEnd.getTime()) return null;

  // The URL is built here, not read from the feed, so the read goes only to GDACS.
  const url = new URL(`${GDACS_API}/polygons/getgeometry`);
  url.searchParams.set("eventtype", type);
  url.searchParams.set("eventid", String(p.eventid));
  url.searchParams.set("episodeid", String(p.episodeid));

  const res = await fetchFeed(url, "gdacs", args.signal);

  if (res.status === 204) return null;

  const { features } = featureListSchema.parse(await res.json());
  let end = gdacsTime(p.todate);
  let inside = false;

  for (const feature of features) {
    const parsed = areaFeatureSchema.safeParse(feature);

    if (!parsed.success || !EVENT_AREA[type](parsed.data.properties)) continue;

    const area = areaGeometrySchema.safeParse(parsed.data.geometry);

    if (!area.success || !containsPoint(area.data, args.place)) continue;

    inside = true;
    // A forecast polygon of a cyclone is later than the event's last observation.
    const at = gdacsTime(parsed.data.properties.polygondate ?? "");

    if (Number.isFinite(at) && !(at <= end)) end = at;
  }

  if (!inside || !(end >= args.dayStart.getTime())) return null;

  const onset = isoInstant(start);
  const expires = isoInstant(end);

  if (onset === null || expires === null) return null;

  const severity = p.severitydata?.severitytext;
  const report = z.url().safeParse(p.url?.report);

  return {
    rank: ALERT_RANK[p.alertlevel],
    warning: {
      source: "gdacs",
      issuer: clipText(
        p.source ? `GDACS (${p.source})` : "GDACS",
        OFFICIAL_WARNING_TEXT_MAX.issuer,
      ),
      event: clipText(p.name, OFFICIAL_WARNING_TEXT_MAX.event),
      severity: clipText(`${p.alertlevel} alert`, OFFICIAL_WARNING_TEXT_MAX.severity),
      headline: clipText(
        severity ? `${p.name}: ${severity}` : p.name,
        OFFICIAL_WARNING_TEXT_MAX.headline,
      ),
      area: clipText(p.country || p.name, OFFICIAL_WARNING_TEXT_MAX.area),
      onset,
      expires,
      ...(report.success ? { url: report.data } : {}),
    },
  };
}

/** The event's point, as the list gives it. */
function centroidOf(event: GdacsEvent) {
  const [lng = 0, lat = 0] = event.geometry.coordinates;

  return { lat, lng };
}

/** GDACS writes UTC times with no zone ("2026-11-01T00:00:00"). `NaN` for an unreadable time. */
function gdacsTime(text: string): number {
  if (text.length === 0) return Number.NaN;

  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`);
}

/** `YYYY-MM-DD` in UTC, the date form of the event list. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;
