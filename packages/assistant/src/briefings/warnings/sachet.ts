import { mapConcurrent, OFFICIAL_WARNING_TEXT_MAX, type PlaceArea } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { clipText, fetchFeed, isoInstant, type FeedRead, type RankedWarning } from "./feed";
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
 * Parsed CAP files by RSS guid. A CAP file does not change after it is published, so this
 * process reads each one time. `null`: the file has a shape that Alfred cannot read. A failed
 * request is not kept, so the next gather tries again. The RSS file has 100 items, so the bound
 * keeps several days of them.
 */
const capCache = new Map<string, CapAlert | null>();

const CAP_CACHE_MAX = 500;

/** The CAP 1.2 severities. The standard closes this set. */
const CAP_SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"] as const;

type CapSeverity = (typeof CAP_SEVERITIES)[number];

const capSeveritySchema = z.enum(CAP_SEVERITIES);

/**
 * The rank of each CAP severity, or `null` when the briefing does not select it. Each rank is the
 * same as the GDACS alert level of the same weight: Red and `Extreme` are 0. A `Moderate` or
 * `Minor` alert is not selected (owner decision, 2026-11-01): on that day most Sachet alerts were
 * IMD nowcasts such as "Light Rain, Moderate", and each would lead the briefing. A value outside
 * CAP 1.2 is not selected either, and `readSachet` logs it as a fault.
 */
const SEVERITY_RANK = {
  Extreme: 0,
  Severe: 1,
  Moderate: null,
  Minor: null,
  Unknown: null,
} as const satisfies Record<CapSeverity, number | null>;

/**
 * The shortest alert that the briefing selects. IMD issues most of its alerts as nowcasts of one
 * to three hours. The user reads the briefing later, so such an alert has often expired. A
 * cyclone, a flood, or a day warning lasts longer (owner decision, 2026-11-01).
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
    sent: text,
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
          effective: text.optional(),
          onset: text.optional(),
          expires: text.optional(),
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
 * The user's district, as the Sachet match needs it. `code`: the LGD (Local Government Directory)
 * district code, when the geocode's names find exactly one district. `uniqueName`: no other state
 * has a district with this name, so a match on the name alone is safe.
 */
export interface SachetDistrict {
  readonly name: string;
  readonly state: string | null;
  readonly code: number | null;
  readonly uniqueName: boolean;
}

/** The district of an Indian place, or `null` when the geocode gave no district. */
export function sachetDistrict(area: PlaceArea): SachetDistrict | null {
  if (area.district === undefined) return null;

  const name = normalizeName(area.district);
  const state = area.region === undefined ? null : normalizeName(area.region);
  const sameName = LGD_DISTRICTS.filter(([, , district]) => normalizeName(district) === name);
  const inState = sameName.filter(([lgdState]) => normalizeName(lgdState) === state);
  const [only] = inState.length === 1 ? inState : sameName.length === 1 ? sameName : [];

  if (only === undefined) {
    logger.warn(
      { district: area.district, region: area.region, candidates: sameName.length },
      "[briefing.warnings] no single LGD district for the place; Sachet matches by name only",
    );
  }

  return { name, state, code: only?.[1] ?? null, uniqueName: sameName.length <= 1 };
}

/**
 * The Sachet alerts that name the user's district and that are in force during the day: they
 * take effect before the day ends and expire after `now`. Only a `Severe` or `Extreme` alert of
 * `MIN_ALERT_MS` or more counts. An alert that a later alert updates or cancels does not count.
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

  await mapConcurrent(
    items,
    CAP_CONCURRENCY,
    async (item) => {
      try {
        const alert = await readCap(item, args.signal);

        if (alert) alerts.push({ item, alert });
      } catch (err) {
        unread += 1;
        logger.warn({ err, guid: item.guid }, "[briefing.warnings] Sachet CAP read failed");
      }
    },
    { signal: args.signal },
  );

  // An update or a cancel names the alerts that it replaces.
  const replaced = new Set(alerts.flatMap(({ alert }) => referencedIdentifiers(alert.references)));
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

    const warning = matchAlert(item, alert, { ...args, info, rank });

    if (!warning) continue;

    // The same warning can come again under a new identifier with no reference.
    const key = `${warning.warning.headline}|${warning.warning.area}`;

    if (seen.has(key)) continue;
    seen.add(key);
    found.push(warning);
  }

  if (offCapAlerts > 0) {
    logger.warn(
      { alerts: offCapAlerts, severities: [...offCap].slice(0, 5) },
      "[briefing.warnings] Sachet alerts with a severity outside CAP 1.2; not selected",
    );
  }

  return { found, unread, total: items.length };
}

async function readCap(item: RssItem, signal: AbortSignal): Promise<CapAlert | null> {
  const cached = capCache.get(item.guid);

  if (cached !== undefined) return cached;

  if (!item.link.startsWith(SACHET_CAP_PREFIX)) {
    logger.warn(
      { guid: item.guid },
      "[briefing.warnings] Sachet item links outside Sachet; not read",
    );

    return null;
  }

  const res = await fetchFeed(new URL(item.link), "ndma_sachet", signal);
  const parsed = capSchema.safeParse(xml.parse(await res.text()));

  if (!parsed.success) {
    logger.warn(
      { guid: item.guid, issues: parsed.error.issues.slice(0, 3) },
      "[briefing.warnings] Sachet CAP file has an unreadable shape",
    );
  }

  const alert = parsed.success ? parsed.data.alert : null;

  if (capCache.size >= CAP_CACHE_MAX) {
    const oldest = capCache.keys().next();

    if (!oldest.done) capCache.delete(oldest.value);
  }

  capCache.set(item.guid, alert);

  return alert;
}

function matchAlert(
  item: RssItem,
  alert: CapAlert,
  args: {
    district: SachetDistrict;
    dayEnd: Date;
    now: Date;
    info: CapAlert["info"][number];
    rank: number;
  },
): RankedWarning | null {
  const { info, rank } = args;
  const start = Date.parse(info.effective || info.onset || alert.sent);
  const end = Date.parse(info.expires ?? "");

  // An alert with no expiry cannot say that it is still in force.
  if (!(start < args.dayEnd.getTime()) || !(end > args.now.getTime())) return null;

  if (!(end - start >= MIN_ALERT_MS)) return null;

  const area = info.area.find((candidate) => areaHasDistrict(candidate, args.district));
  const onset = isoInstant(start);
  const expires = isoInstant(end);

  if (!area || onset === null || expires === null) return null;

  return {
    rank,
    warning: {
      source: "ndma_sachet",
      issuer: clipText(
        authorName(item.author) || info.senderName || alert.sender || "NDMA Sachet",
        OFFICIAL_WARNING_TEXT_MAX.issuer,
      ),
      event: clipText(info.event, OFFICIAL_WARNING_TEXT_MAX.event),
      severity: clipText(info.severity, OFFICIAL_WARNING_TEXT_MAX.severity),
      headline: clipText(info.headline || info.event, OFFICIAL_WARNING_TEXT_MAX.headline),
      area: clipText(area.areaDesc || args.district.name, OFFICIAL_WARNING_TEXT_MAX.area),
      onset,
      expires,
    },
  };
}

/**
 * When the district has an LGD code, an area with LGD codes matches only by code: the code is
 * exact, and a name can be in two states. Any other area (for example a CWC river gauge, which has
 * no code) matches when its text names the district and the state, or the district alone when no
 * other state has a district with that name.
 */
function areaHasDistrict(area: CapArea, district: SachetDistrict): boolean {
  const codes = (area.geocode ?? [])
    .filter((geocode) => /lgd\s+district\s+code/i.test(geocode.valueName))
    .map((geocode) => Number.parseInt(geocode.value, 10));

  if (codes.length > 0 && district.code !== null) return codes.includes(district.code);

  const words = ` ${normalizeName(area.areaDesc)} `;

  if (!words.includes(` ${district.name} `)) return false;

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
