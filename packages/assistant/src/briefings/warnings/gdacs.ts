import {
  mapConcurrent,
  OFFICIAL_WARNING_TEXT_MAX,
  parseIanaTimezone,
  type Place,
} from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { addDays, inZone } from "@alfred/assistant/time";
import { z } from "zod";
import { clipText, fetchFeed, type FeedRead, type RankedWarning } from "./feed";
import { areaGeometrySchema, containsPoint, distanceKm } from "./geometry";

/**
 * GDACS (Global Disaster Alert and Coordination System, UN and EU) as a warnings feed (ADR-0117
 * decision 4). It covers the large events in every country. Alfred reads only the Orange and Red
 * events, the API's own default: a Green event has a small expected impact, and the national feed
 * carries the local warnings.
 */

const GDACS_API = "https://www.gdacs.org/gdacsapi/api";

/**
 * The event list writes its dates as UTC calendar days ("2026-11-01"), so the query window is a
 * day range in UTC.
 */
const GDACS_DAYS = inZone(parseIanaTimezone("UTC"));

/**
 * The event types that Alfred reads. A drought (DR) is not read: its dates span months, so it
 * overlaps every query window and would be an "at risk" item in every briefing.
 */
const GDACS_EVENT_TYPES = ["TC", "EQ", "FL", "VO", "WF"] as const;

type GdacsEventType = (typeof GDACS_EVENT_TYPES)[number];

/**
 * The alert levels that the event list asks for. A Green event is not asked for, so any other
 * level in a reply is a feed fault: the event is skipped and counted as unread.
 */
const GDACS_ALERT_LEVELS = ["Red", "Orange"] as const;

type GdacsAlertLevel = (typeof GDACS_ALERT_LEVELS)[number];

/** The API gives at most 100 events in a page. */
const PAGE_SIZE = 100;

/** Orange and Red events in a few days are far fewer than five pages. More counts as unread. */
const MAX_PAGES = 5;

/**
 * Days before the briefing day where the query window starts. The event list gives each event
 * whose dates (`fromdate` to `todate`) overlap the window, so an event that started long before
 * the window, such as a flood of several weeks, is in it. For an event in progress, `todate` is
 * its last update, not its end. In the capture of 2026-11-01, a current flood had a `todate` three
 * days old, and GDACS marked each flood and fire with a `todate` four days old as not current. So
 * seven days lists each event that GDACS still marks as current. An event that is not current is
 * dropped before its area read, so a wide window costs no area read.
 */
const LIST_DAYS_BEFORE = 7;

/**
 * Event areas that one gather reads, the nearest first. In the capture of 2026-11-01, one of the
 * 100 newest GDACS events was Orange or Red, so a normal list is far below 20. The bound caps the
 * requests and the bytes (an earthquake ShakeMap is 1.4 MB) that one gather takes from a public
 * server: five rounds of `AREA_READ_CONCURRENCY`. An event past the bound counts as unread.
 */
const MAX_AREA_READS = 20;

/** Parallel area reads, so 20 reads take seconds and do not load the public GDACS server. */
const AREA_READ_CONCURRENCY = 4;

/**
 * The lowest shaking intensity (Modified Mercalli, from the GDACS ShakeMap polygons) that is a
 * warning: V, felt by nearly everyone, with objects that move. A lower intensity reaches far from
 * the epicentre and is not a risk.
 */
const EQ_MIN_INTENSITY = 5;

/**
 * A GDACS time as epoch milliseconds. GDACS writes UTC times with no zone ("2026-11-01T00:00:00").
 * A time that `Date.parse` cannot read fails the parse.
 */
const gdacsTime = z
  .string()
  .transform((text) => Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`))
  .pipe(z.number());

const eventSchema = z.object({
  geometry: z.object({ coordinates: z.array(z.number()).min(2) }),
  properties: z.object({
    eventtype: z.enum(GDACS_EVENT_TYPES),
    eventid: z.number().int(),
    episodeid: z.number().int(),
    name: z.string().min(1),
    alertlevel: z.enum(GDACS_ALERT_LEVELS),
    iscurrent: z.enum(["true", "false"]),
    fromdate: gdacsTime,
    todate: gdacsTime,
    country: z.string().optional(),
    source: z.string().optional(),
    url: z.object({ report: z.string().optional() }).optional(),
    severitydata: z.object({ severitytext: z.string().optional() }).optional(),
  }),
});

type GdacsEvent = z.infer<typeof eventSchema>;

const featureListSchema = z.object({ features: z.array(z.unknown()) });

/** A feature of an event geometry. Its geometry is parsed only when the feature is a hazard area. */
const geometryFeatureSchema = z.object({
  geometry: z.unknown(),
  properties: z.object({
    Class: z.string(),
    intensity: z.number().optional(),
    polygondate: gdacsTime.optional(),
  }),
});

type FeatureProperties = z.infer<typeof geometryFeatureSchema>["properties"];

/**
 * What a feature of an event geometry is. `hazard`: an area where the hazard is. `other`: a feature
 * that is not such an area (a track line, a centroid point, a river basin, a low intensity).
 * `unreadable`: the feature does not give a value that the test needs.
 */
type FeatureRole = "hazard" | "other" | "unreadable";

/**
 * The hazard areas of each event type. The probe of 2026-11-01 found these classes. Each other
 * class (a track line, a 100 km circle around an epicentre, a river basin) is not an area where the
 * hazard is.
 *
 * - TC: the 60, 90, and 120 km/h wind buffers, and the uncertainty cone of the track.
 * - EQ: the ShakeMap intensity polygons at `EQ_MIN_INTENSITY` or more. A ShakeMap polygon with no
 *   intensity is unreadable, not intensity 0.
 * - FL: the affected area. `Poly_Global` is the whole basin.
 * - VO: the circle around the volcano.
 * - WF: the burned area.
 */
const EVENT_AREA = {
  TC: ({ Class }) =>
    ["Poly_Green", "Poly_Orange", "Poly_Red", "Poly_Cones"].includes(Class) ? "hazard" : "other",
  EQ: ({ Class, intensity }) => {
    if (!Class.startsWith("Poly_SMPInt")) return "other";

    if (intensity === undefined) return "unreadable";

    return intensity >= EQ_MIN_INTENSITY ? "hazard" : "other";
  },
  FL: ({ Class }) => (Class === "Poly_Affected" ? "hazard" : "other"),
  VO: ({ Class }) => (Class === "Poly_Circle" ? "hazard" : "other"),
  WF: ({ Class }) => (Class === "Poly_area" ? "hazard" : "other"),
} as const satisfies Record<GdacsEventType, (properties: FeatureProperties) => FeatureRole>;

/** Red before Orange. */
const ALERT_RANK = {
  Red: 0,
  Orange: 1,
} as const satisfies Record<GdacsAlertLevel, number>;

/**
 * The result of one event area read. `warning`: the area contains the place. `clear`: each hazard
 * area was read and none contains the place. `unreadable`: Alfred cannot tell, because the reply
 * had no geometry or a hazard feature that it could not read. A failed request throws instead.
 */
type AreaRead =
  | { readonly kind: "warning"; readonly warning: RankedWarning }
  | { readonly kind: "clear" }
  | { readonly kind: "unreadable" };

/**
 * The GDACS events that are in force at the run and whose area contains the place. GDACS marks
 * an event in progress as current (`iscurrent`), and an event that ended is not. The `todate` of an
 * event in progress is its last update, so it is earlier than the run and cannot tell whether
 * the event is in force. An event that started after the briefing day (`dayEnd`) is not selected.
 *
 * The test is containment, with no distance band: on 2026-10-28 the nearest wind buffer of
 * cyclone ARNAB-26 was 318 km from Bhubaneswar, and a band that wide selects much of a coast. The
 * national feed carries the district warnings.
 *
 * `total` counts each listed event. `unread` counts the events that Alfred could not read or did
 * not read, and one more when the list is over its page bound.
 */
export async function readGdacs(args: {
  place: Place;
  dayStart: Date;
  dayEnd: Date;
  signal: AbortSignal;
}): Promise<FeedRead> {
  const list = await listEvents(args);
  const dayEnd = args.dayEnd.getTime();

  const byDistance = list.events
    .filter(({ properties }) => properties.iscurrent === "true" && properties.fromdate < dayEnd)
    .map((event) => ({ event, km: distanceKm(args.place, reportedPoint(event)) }))
    .toSorted((a, b) => a.km - b.km);

  const toRead = byDistance.slice(0, MAX_AREA_READS).map(({ event }) => event);
  const notRead = byDistance.length - toRead.length;

  if (notRead > 0) {
    logger.warn(
      { events: byDistance.length, read: MAX_AREA_READS },
      "[briefing.warnings] GDACS events over the read bound; the farthest are not read",
    );
  }

  const found: RankedWarning[] = [];
  let unread = list.unread + notRead;
  let stopped = 0;

  // `mapConcurrent` does not get the signal: an abort there throws and loses the areas already
  // read. After an abort, each read that is left fails at once in `fetchFeed`.
  await mapConcurrent(toRead, AREA_READ_CONCURRENCY, async (event) => {
    try {
      const read = await readEventArea(event, args);

      if (read.kind === "warning") found.push(read.warning);
      else if (read.kind === "unreadable") unread += 1;
    } catch (err) {
      unread += 1;

      if (args.signal.aborted) {
        stopped += 1;

        return;
      }

      logger.warn(
        { err, eventId: event.properties.eventid },
        "[briefing.warnings] GDACS event area read failed",
      );
    }
  });

  if (stopped > 0) {
    logger.warn(
      { err: args.signal.reason, stopped, read: toRead.length - stopped },
      "[briefing.warnings] GDACS area reads stopped by the abort; the areas already read are kept",
    );
  }

  return { found, unread, total: list.total };
}

/**
 * The events that overlap the query window. `unread`: the listed events that Alfred could not
 * parse, and one more when the list is over its page bound (the number past the bound is not
 * known). `total`: each listed event, and that one.
 */
async function listEvents(args: {
  dayStart: Date;
  dayEnd: Date;
  signal: AbortSignal;
}): Promise<{ events: GdacsEvent[]; unread: number; total: number }> {
  const from = addDays(GDACS_DAYS.day(args.dayStart), -LIST_DAYS_BEFORE);
  const to = GDACS_DAYS.day(args.dayEnd);
  const events: GdacsEvent[] = [];
  let unread = 0;
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`${GDACS_API}/events/geteventlist/SEARCH`);
    url.searchParams.set("eventlist", GDACS_EVENT_TYPES.join(";"));
    url.searchParams.set("alertlevel", GDACS_ALERT_LEVELS.join(";"));
    url.searchParams.set("fromDate", from);
    url.searchParams.set("toDate", to);
    url.searchParams.set("pagenumber", String(page));

    const res = await fetchFeed(url, "gdacs", args.signal);

    // An empty page is a 204 with no body.
    if (res.status === 204) break;

    const { features } = featureListSchema.parse(await res.json());

    total += features.length;

    for (const feature of features) {
      const event = eventSchema.safeParse(feature);

      if (event.success) events.push(event.data);
      else unread += 1;
    }

    if (features.length < PAGE_SIZE) break;

    if (page === MAX_PAGES) {
      unread += 1;
      total += 1;
      logger.warn(
        { pages: MAX_PAGES },
        "[briefing.warnings] GDACS event list over its page bound; the rest counts as unread",
      );
    }
  }

  if (unread > 0) {
    logger.warn(
      { unread },
      "[briefing.warnings] GDACS events with an unreadable shape, type, level, or date",
    );
  }

  return { events, unread, total };
}

/**
 * Reads the event's geometry and tests whether a hazard area contains the place. A forecast
 * polygon of a cyclone counts at any forecast time: a polygon for a later day that contains the
 * place selects the event today, so a landfall tomorrow is in today's briefing (owner decision).
 */
async function readEventArea(
  event: GdacsEvent,
  args: { place: Place; signal: AbortSignal },
): Promise<AreaRead> {
  const { properties } = event;

  // The URL is built here, not read from the feed, so the read goes only to GDACS.
  const url = new URL(`${GDACS_API}/polygons/getgeometry`);
  url.searchParams.set("eventtype", properties.eventtype);
  url.searchParams.set("eventid", String(properties.eventid));
  url.searchParams.set("episodeid", String(properties.episodeid));

  const res = await fetchFeed(url, "gdacs", args.signal);

  // An Orange or Red event with no geometry: Alfred cannot tell whether it touches the place.
  if (res.status === 204) return { kind: "unreadable" };

  const { features } = featureListSchema.parse(await res.json());
  let end = properties.todate;
  let inside = false;
  let unreadable = false;

  for (const feature of features) {
    const parsed = geometryFeatureSchema.safeParse(feature);

    if (!parsed.success) {
      unreadable = true;
      continue;
    }

    const role = EVENT_AREA[properties.eventtype](parsed.data.properties);

    if (role === "other") continue;

    const area = areaGeometrySchema.safeParse(parsed.data.geometry);

    if (role === "unreadable" || !area.success) {
      unreadable = true;
      continue;
    }

    if (!containsPoint(area.data, args.place)) continue;

    inside = true;

    // A forecast polygon of a cyclone is later than the event's last update.
    const at = parsed.data.properties.polygondate;

    if (at !== undefined && at > end) end = at;
  }

  if (!inside) return unreadable ? { kind: "unreadable" } : { kind: "clear" };

  const severity = properties.severitydata?.severitytext;
  const report = z.url().safeParse(properties.url?.report);

  return {
    kind: "warning",
    warning: {
      rank: ALERT_RANK[properties.alertlevel],
      warning: {
        source: "gdacs",
        issuer: clipText(
          properties.source ? `GDACS (${properties.source})` : "GDACS",
          OFFICIAL_WARNING_TEXT_MAX.issuer,
        ),
        event: clipText(properties.name, OFFICIAL_WARNING_TEXT_MAX.event),
        severity: clipText(`${properties.alertlevel} alert`, OFFICIAL_WARNING_TEXT_MAX.severity),
        headline: clipText(
          severity ? `${properties.name}: ${severity}` : properties.name,
          OFFICIAL_WARNING_TEXT_MAX.headline,
        ),
        area: clipText(properties.country || properties.name, OFFICIAL_WARNING_TEXT_MAX.area),
        // `gdacsTime` parses only to a valid time, so `toISOString` does not throw.
        onset: new Date(properties.fromdate).toISOString(),
        expires: new Date(end).toISOString(),
        ...(report.success ? { url: report.data } : {}),
      },
    },
  };
}

/** The point that the event list gives for the event. It orders the area reads, nearest first. */
function reportedPoint(event: GdacsEvent) {
  const [lng = 0, lat = 0] = event.geometry.coordinates;

  return { lat, lng };
}
