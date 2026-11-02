import { isNonBlankString, mapConcurrent, type PlaceArea } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  buildWarning,
  fetchFeed,
  WARNING_RANK,
  type FeedRead,
  type RankedWarning,
  type WarningBuild,
  type WarningRank,
} from "./feed";
import { LGD_DISTRICTS } from "./lgd-districts";

/**
 * NDMA Sachet, India's CAP (Common Alerting Protocol) feed, as a warnings feed (ADR-0117 decision
 * 4). IMD, CWC, and the state disaster authorities publish their warnings through it. The RSS
 * file lists the last 100 alerts (about two days), and each item links to one CAP file. Sachet
 * also has polygons, but its firewall refuses a script, so the match is by district.
 */

const SACHET_RSS = "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml";

/** The CAP files come only from this path. A link elsewhere is not read. */
const SACHET_CAP_PREFIX = "https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?";

/** Parallel CAP reads, so 100 reads take seconds and do not load the government server. */
const CAP_CONCURRENCY = 6;

/**
 * Parsed CAP alerts by RSS guid. A CAP file does not change after it is published, so this
 * process reads each one time. Only a parsed alert is kept. A failed request or an unreadable
 * body (for example a firewall page with status 200) is not kept, so the next gather tries again.
 * The RSS file has 100 items, so the bound keeps several days of them.
 */
const capCache = new Map<string, CapAlert>();

const CAP_CACHE_MAX = 500;

/** The CAP 1.2 severities. The standard closes this set. */
const CAP_SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"] as const;

type CapSeverity = (typeof CAP_SEVERITIES)[number];

const capSeveritySchema = z.enum(CAP_SEVERITIES);

/**
 * The rank of each CAP severity on the scale of all feeds (`WARNING_RANK`), or `null` when the
 * briefing does not select it. Red and `Extreme` have the same rank. A `Moderate` or `Minor`
 * alert is not selected (owner decision, 2026-11-01): on that day most Sachet alerts were IMD
 * nowcasts such as "Light Rain, Moderate", and each would lead the briefing. A value outside CAP
 * 1.2 is not selected either, and `readSachet` logs it as a fault.
 */
const SEVERITY_RANK = {
  Extreme: WARNING_RANK.extreme,
  Severe: WARNING_RANK.severe,
  Moderate: null,
  Minor: null,
  Unknown: null,
} as const satisfies Record<CapSeverity, WarningRank | null>;

/**
 * The shortest alert that the briefing selects. IMD issues most of its alerts as nowcasts of one
 * to three hours. The user reads the briefing later, so such an alert has often expired. A
 * cyclone, a flood, or a day warning lasts longer (owner decision, 2026-11-01). The rule measures
 * the hazard window that the briefing shows: from `onset` (or `effective`, then `sent`, when the
 * alert has no `onset`) to `expires`. CAP has no end time for the hazard, so `expires`, the end of
 * the message, is the end.
 */
const MIN_ALERT_MS = 6 * 60 * 60 * 1000;

/** The tags that can repeat. The parser gives each as an array, also when one is present. */
const REPEATED_TAGS = new Set(["item", "info", "area", "geocode", "parameter"]);

const xml = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) => REPEATED_TAGS.has(tagName),
});

const text = z.string();

/**
 * A CAP time as epoch milliseconds. CAP 1.2 requires a zone offset ("2026-11-01T20:55:45+05:30").
 * A time with no offset, or an empty value, fails the parse, so the alert is unreadable: `Date.parse`
 * would read a time with no offset as server-local time.
 */
const capTime = z.iso
  .datetime({ offset: true })
  .transform((value) => Date.parse(value))
  .pipe(z.number());

const rssSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z
        .array(
          z.object({
            link: text,
            guid: text,
            author: text.optional(),
          }),
        )
        .default([]),
    }),
  }),
});

type RssItem = z.infer<typeof rssSchema>["rss"]["channel"]["item"][number];

const capSchema = z.object({
  alert: z.object({
    identifier: text.min(1),
    sender: text,
    sent: capTime,
    status: text,
    msgType: text,
    references: text.optional(),
    info: z
      .array(
        z.object({
          language: text.optional(),
          event: text.min(1),
          severity: text,
          senderName: text.optional(),
          headline: text.optional(),
          effective: capTime.optional(),
          onset: capTime.optional(),
          expires: capTime.optional(),
          area: z
            .array(
              z.object({
                areaDesc: text,
                geocode: z.array(z.object({ valueName: text, value: text })).optional(),
              }),
            )
            .default([]),
        }),
      )
      .default([]),
  }),
});

type CapAlert = z.infer<typeof capSchema>["alert"];

type CapArea = CapAlert["info"][number]["area"][number];

/**
 * The result of one CAP read. `off_sachet`: the item links outside Sachet, so Alfred did not read
 * it. `unreadable`: the body does not have the CAP shape. A failed request throws instead.
 */
type CapRead =
  | { readonly kind: "alert"; readonly alert: CapAlert }
  | { readonly kind: "off_sachet" }
  | { readonly kind: "unreadable" };

/**
 * The user's district, as the Sachet match needs it. `name`: the geocode's spelling, to show.
 * `key` and `state`: the comparison keys of the district and the state. `code`: the LGD (Local
 * Government Directory) district code, when exactly one LGD district has the name in the user's
 * state. `uniqueName`: LGD has exactly one district with this name and that district is the
 * user's district, so a match on the name alone is safe.
 */
export interface SachetDistrict {
  readonly name: string;
  readonly key: string;
  readonly state: string | null;
  readonly code: number | null;
  readonly uniqueName: boolean;
}

/** The comparison keys of the LGD states. */
const LGD_STATES = new Set(LGD_DISTRICTS.map(([state]) => normalizeName(state)));

/** Sachet covers India only. A place in another country has no Sachet read. */
export function sachetCovers(area: PlaceArea): boolean {
  return area.countryCode === "IN";
}

/**
 * The district of a place that Sachet covers, or `null` when Sachet does not cover the place or
 * the geocode gave no district. When the geocode gives a state that LGD knows, only a district in
 * that state can give the code. A district with the same name in another state is a different
 * district: LGD has Aurangabad only in Bihar, and Maharashtra renamed its Aurangabad to
 * Chhatrapati Sambhajinagar. When the state is not known, the name gives the code only if one LGD
 * district has it.
 */
export function sachetDistrict(area: PlaceArea): SachetDistrict | null {
  if (!sachetCovers(area) || area.district === undefined) return null;

  const key = normalizeName(area.district);
  const state = area.region === undefined ? null : normalizeName(area.region);
  const lgdState = state !== null && LGD_STATES.has(state) ? state : null;
  const sameName = LGD_DISTRICTS.filter(([, , district]) => normalizeName(district) === key);
  const inState = sameName.filter(([districtState]) => normalizeName(districtState) === lgdState);
  const candidates = lgdState === null ? sameName : inState;
  const [only] = candidates.length === 1 ? candidates : [];

  if (only === undefined) {
    logger.warn(
      {
        district: area.district,
        region: area.region,
        stateKnown: lgdState !== null,
        sameName: sameName.length,
        inState: candidates.length,
      },
      "[briefing.official-warnings] no single LGD district for the place; Sachet needs the district and state names in the area text",
    );
  }

  return {
    name: area.district,
    key,
    state,
    code: only?.[1] ?? null,
    uniqueName: only !== undefined && sameName.length === 1,
  };
}

/**
 * The Sachet alerts that name the user's district and that are in force during the day: the
 * hazard starts (`onset`, else `effective`, else `sent`) before the day ends, and the alert
 * expires after `now`. Only a `Severe` or `Extreme` alert of `MIN_ALERT_MS` or more counts. An
 * alert that an `Actual` update or cancel names does not count. A matched alert that fails the
 * contract parse counts in `unread`. Only a failed RSS read throws. When `signal` aborts, the CAP
 * reads stop, the alerts already read stay, and the items that were not read count in `unread`.
 */
export async function readSachet(args: {
  district: SachetDistrict;
  dayEnd: Date;
  now: Date;
  signal: AbortSignal;
}): Promise<FeedRead> {
  const res = await fetchFeed(new URL(SACHET_RSS), "ndma_sachet", args.signal);
  const items = rssSchema.parse(xml.parse(await res.text())).rss.channel.item;
  const alerts: { readonly item: RssItem; readonly alert: CapAlert }[] = [];
  let unread = 0;
  let stopped = 0;

  // `mapConcurrent` does not get the signal: an abort there throws and loses the alerts already
  // read. After an abort, each item that is left fails at once in `fetchFeed` (or comes from the
  // cache), so the loop ends without a new request.
  await mapConcurrent(items, CAP_CONCURRENCY, async (item) => {
    try {
      const read = await readCap(item, args.signal);

      if (read.kind === "alert") alerts.push({ item, alert: read.alert });
      else unread += 1;
    } catch (err) {
      if (args.signal.aborted) {
        stopped += 1;

        return;
      }

      unread += 1;
      logger.warn({ err, guid: item.guid }, "[briefing.official-warnings] Sachet CAP read failed");
    }
  });

  if (stopped > 0) {
    unread += stopped;
    logger.warn(
      { err: args.signal.reason, stopped, read: alerts.length, total: items.length },
      "[briefing.official-warnings] Sachet CAP reads stopped by the abort; the alerts already read are kept",
    );
  }

  // An update or a cancel names the alerts that it replaces. Only an `Actual` alert can replace
  // one: a `Test` or `Exercise` update that names a real alert does not remove it.
  const replaced = new Set(
    alerts.flatMap(({ alert }) =>
      alert.status === "Actual" && (alert.msgType === "Update" || alert.msgType === "Cancel")
        ? referencedIdentifiers(alert.references)
        : [],
    ),
  );

  const found: RankedWarning[] = [];
  const seen = new Set<string>();
  const offCap = new Set<string>();
  let offCapAlerts = 0;

  for (const { item, alert } of alerts) {
    if (alert.status !== "Actual" || replaced.has(alert.identifier)) continue;

    if (alert.msgType !== "Alert" && alert.msgType !== "Update") continue;

    const info = alert.info.find((entry) => entry.language?.startsWith("en")) ?? alert.info[0];

    if (!info) continue;

    const severity = capSeveritySchema.safeParse(info.severity);

    // A feed change or a typo, not an intended drop: not selected, and logged below.
    if (!severity.success) {
      offCapAlerts += 1;
      offCap.add(info.severity);
      continue;
    }

    const rank = SEVERITY_RANK[severity.data];

    if (rank === null) continue;

    const built = matchAlert(item, alert, { ...args, info, rank });

    if (built === null) continue;

    if (built.kind === "rejected") {
      unread += 1;
      continue;
    }

    const { warning } = built;

    // The same warning can come again under a new identifier with no reference.
    const key = `${warning.warning.headline}|${warning.warning.area}`;

    if (seen.has(key)) continue;
    seen.add(key);
    found.push(warning);
  }

  if (offCapAlerts > 0) {
    logger.warn(
      { alerts: offCapAlerts, severities: [...offCap].slice(0, 5) },
      "[briefing.official-warnings] Sachet alerts with a severity outside CAP 1.2; not selected",
    );
  }

  return { found, unread, total: items.length };
}

/** One CAP file. A request that fails (a status that is not 2xx, a timeout, an abort) throws. */
async function readCap(item: RssItem, signal: AbortSignal): Promise<CapRead> {
  const cached = capCache.get(item.guid);

  if (cached !== undefined) return { kind: "alert", alert: cached };

  if (!item.link.startsWith(SACHET_CAP_PREFIX)) {
    logger.warn(
      { guid: item.guid },
      "[briefing.official-warnings] Sachet item links outside Sachet; not read",
    );

    return { kind: "off_sachet" };
  }

  const res = await fetchFeed(new URL(item.link), "ndma_sachet", signal);
  const parsed = capSchema.safeParse(xml.parse(await res.text()));

  if (!parsed.success) {
    logger.warn(
      { guid: item.guid, issues: parsed.error.issues.slice(0, 3) },
      "[briefing.official-warnings] Sachet CAP file has an unreadable shape",
    );

    return { kind: "unreadable" };
  }

  if (capCache.size >= CAP_CACHE_MAX) {
    const oldest = capCache.keys().next();

    if (!oldest.done) capCache.delete(oldest.value);
  }

  capCache.set(item.guid, parsed.data.alert);

  return { kind: "alert", alert: parsed.data.alert };
}

/**
 * The alert as a warning when it is in force during the day, lasts `MIN_ALERT_MS` or more, and
 * names the district. `null`: the alert does not match.
 */
function matchAlert(
  item: RssItem,
  alert: CapAlert,
  args: {
    district: SachetDistrict;
    dayEnd: Date;
    now: Date;
    info: CapAlert["info"][number];
    rank: WarningRank;
  },
): WarningBuild | null {
  const { info, rank } = args;
  // CAP 1.2: `onset` is the expected start of the hazard, and `effective` is only when the message
  // takes effect. A warning that takes effect today for a hazard tomorrow is tomorrow's warning.
  const start = info.onset ?? info.effective ?? alert.sent;
  const end = info.expires;

  // An alert with no expiry cannot say that it is still in force.
  if (end === undefined || start >= args.dayEnd.getTime() || end <= args.now.getTime()) {
    return null;
  }

  if (end - start < MIN_ALERT_MS) return null;

  const area = info.area.find((candidate) => areaHasDistrict(candidate, args.district));

  if (!area) return null;

  // Each fallback skips a value that is blank after the whitespace fold, because `buildWarning`
  // rejects the warning when a blank value wins.
  return buildWarning({
    source: "ndma_sachet",
    rank,
    issuer:
      [authorName(item.author), info.senderName, alert.sender].find(isNonBlankString) ??
      "NDMA Sachet",
    event: info.event,
    severity: info.severity,
    headline: isNonBlankString(info.headline) ? info.headline : info.event,
    area: isNonBlankString(area.areaDesc) ? area.areaDesc : args.district.name,
    onset: start,
    expires: end,
  });
}

/**
 * When the district has an LGD code, an area with LGD codes matches only by code: the code is
 * exact, and a name can be in two states. Any other area (for example a CWC river gauge, which has
 * no code) matches when its text names the district and the state. The district name alone is
 * enough only when `uniqueName` proves that no other LGD district has the name.
 */
function areaHasDistrict(area: CapArea, district: SachetDistrict): boolean {
  const codes = (area.geocode ?? [])
    .filter((geocode) => /lgd\s+district\s+code/i.test(geocode.valueName))
    .map((geocode) => Number.parseInt(geocode.value, 10));

  if (codes.length > 0 && district.code !== null) return codes.includes(district.code);

  const words = ` ${normalizeName(area.areaDesc)} `;

  if (!words.includes(` ${district.key} `)) return false;

  return district.uniqueName || (district.state !== null && words.includes(` ${district.state} `));
}

/** The identifiers in a CAP `references` value: "sender,identifier,sent" triples, space-separated. */
function referencedIdentifiers(references: string | undefined): string[] {
  if (!references) return [];

  return references.split(/\s+/).flatMap((triple) => {
    const identifier = triple.split(",")[1];

    return identifier ? [identifier] : [];
  });
}

/** "controlroom@ndma.gov.in (IMD Bengaluru)" gives "IMD Bengaluru". */
function authorName(author: string | undefined): string {
  return author?.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? "";
}

/**
 * A place name for comparison: lower case, no accents, words of letters and digits, and no
 * "district" word. LGD writes "Khordha"; an area text writes "Khordha district of Odisha".
 */
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:districts?|dist)\b/g, " ")
    .replace(/\s+/g, " ") // drift-ok: a comparison key, not display text
    .trim();
}
