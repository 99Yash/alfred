import {
  BRIEFING_REFERENCE_KINDS,
  type BriefingGather,
  type BriefingReferenceKind,
  type BriefingSourcePanel,
  type BriefingSourcePanelItem,
  type FullBriefingSection,
  type GatherSourceSlug,
} from "@alfred/contracts";

export type BriefingReference = `${BriefingReferenceKind}:${string}`;

export interface BriefingReferenceOption {
  reference: BriefingReference;
  label: string;
  source: GatherSourceSlug;
}

export type BriefingSegment =
  | { kind: "text"; text: string }
  | {
      kind: "reference";
      reference: BriefingReference;
      label: string;
      href?: string;
      source: GatherSourceSlug;
    };

export interface ResolveBriefingReferencesResult {
  segments: BriefingSegment[];
  resolved: BriefingReference[];
  unresolved: string[];
}

export interface RenderBriefingEmailArgs {
  segments: BriefingSegment[];
  fullBriefingUrl?: string;
}

export interface RenderedBriefingEmail {
  html: string;
  text: string;
}

interface ReferenceEntity {
  reference: BriefingReference;
  label: string;
  href?: string;
  source: GatherSourceSlug;
}

interface ParsedBriefingReference {
  kind: BriefingReferenceKind;
  id: string;
  reference: BriefingReference;
}

const REFERENCE_RE = /\[\[([a-z_]+):([^\]\s]+)\]\]/g;
const BRIEFING_REFERENCE_KIND_SET: ReadonlySet<string> = new Set(BRIEFING_REFERENCE_KINDS);

export function resolveBriefingReferences(
  markdown: string,
  gather: BriefingGather,
): ResolveBriefingReferencesResult {
  const entities = buildReferenceEntityMap(gather);
  const segments: BriefingSegment[] = [];
  const resolved: BriefingReference[] = [];
  const unresolved: string[] = [];

  let cursor = 0;
  for (const match of markdown.matchAll(REFERENCE_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: markdown.slice(cursor, start) });
    }

    const raw = rawReferenceFromMatch(match);
    const parsed = parseBriefingReferenceString(raw);
    const entity = parsed ? entities.get(parsed.reference) : undefined;
    if (entity) {
      segments.push({ kind: "reference", ...entity });
      resolved.push(entity.reference);
    } else {
      segments.push({ kind: "text", text: raw });
      unresolved.push(raw);
    }

    cursor = start + match[0].length;
  }

  if (cursor < markdown.length) {
    segments.push({ kind: "text", text: markdown.slice(cursor) });
  }

  return { segments, resolved, unresolved };
}

export function referencesFromSections(sections: FullBriefingSection[]): BriefingReference[] {
  const refs = new Set<BriefingReference>();
  for (const section of sections) {
    for (const reference of section.references ?? []) {
      const parsed = parseBriefingReferenceString(reference);
      if (parsed) refs.add(parsed.reference);
    }
    for (const match of section.body.matchAll(REFERENCE_RE)) {
      const parsed = parseBriefingReferenceString(rawReferenceFromMatch(match));
      if (parsed) refs.add(parsed.reference);
    }
  }
  return [...refs];
}

export function listBriefingReferenceOptions(gather: BriefingGather): BriefingReferenceOption[] {
  return [...buildReferenceEntityMap(gather).values()].map(({ reference, label, source }) => ({
    reference,
    label,
    source,
  }));
}

export function buildBriefingSourcePanels(
  gather: BriefingGather,
  references: readonly BriefingReference[] = [],
): BriefingSourcePanel[] {
  const referenced = new Set(references);
  const panels: BriefingSourcePanel[] = [];

  const emailItems = emailPanelItems(gather, referenced);
  panels.push({ source: "email", label: "Email", items: emailItems });

  if (gather.calendar) {
    panels.push({
      source: "calendar",
      label: "Calendar",
      items: gather.calendar.events.map((event) => ({
        id: event.eventId,
        title: event.title,
        subtitle: formatDateRange(event.start, event.end),
        href: undefined,
        reference: briefingReference("meeting", event.eventId),
        metadata: compactMetadata({
          attendees: event.attendees.length ? String(event.attendees.length) : undefined,
          location: event.location,
        }),
      })),
    });
  }

  panels.push({
    source: "integration_activity",
    label: "Activity",
    items: gather.integration_activity.items.map((item) => ({
      id: item.id,
      title: item.title,
      subtitle: integrationSubtitle(item.provider, item.providerKind, item.relatedRepo),
      status: item.status,
      severity: item.severity,
      href: item.url,
      reference: briefingReference("activity", item.id),
      metadata: compactMetadata({
        category: item.activityCategory,
        occurredAt: item.occurredAt,
        events: item.rollup?.eventCount ? String(item.rollup.eventCount) : undefined,
        attempts: item.rollup?.attemptCount ? String(item.rollup.attemptCount) : undefined,
        durationMinutes: item.rollup?.durationMinutes
          ? String(item.rollup.durationMinutes)
          : undefined,
      }),
    })),
  });

  if (gather.weather) {
    panels.push({
      source: "weather",
      label: "Weather",
      items: [
        {
          id: "weather:current",
          title: gather.weather.current.description,
          subtitle: `${Math.round(gather.weather.current.temperatureC)}C now, ${Math.round(
            gather.weather.forecast.highC,
          )}C high`,
          metadata: compactMetadata({
            feelsLikeC: String(Math.round(gather.weather.current.apparentTemperatureC)),
            precipitationMm: String(gather.weather.forecast.precipitationMm),
            forecast: gather.weather.forecast.description,
          }),
        },
      ],
    });
  }

  panels.push({
    source: "day_of_week",
    label: "Day",
    items: [
      {
        id: "day_of_week",
        title: gather.day_of_week.dayName,
        subtitle: gather.day_of_week.holiday?.name,
        metadata: compactMetadata({
          weekend: gather.day_of_week.isWeekend ? "true" : undefined,
          locale: gather.day_of_week.holiday?.locale,
        }),
      },
    ],
  });

  return panels
    .map((panel) => ({
      ...panel,
      items: prioritizeReferenced(panel.items, referenced).slice(0, 50),
    }))
    .filter((panel) => panel.items.length > 0);
}

export function renderBriefingEmailHtml(args: RenderBriefingEmailArgs): RenderedBriefingEmail {
  const text = renderSegmentsText(args.segments);
  const html = [
    `<div style="${EMAIL_WRAPPER_STYLE}">`,
    `  <p style="${EMAIL_P_STYLE}">${renderSegmentsHtml(args.segments)}</p>`,
    args.fullBriefingUrl
      ? `  <p style="${EMAIL_P_STYLE}"><a href="${escapeHtml(args.fullBriefingUrl)}" style="${EMAIL_LINK_STYLE}">View full briefing</a></p>`
      : "",
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    html,
    text: args.fullBriefingUrl ? `${text}\n\nView full briefing: ${args.fullBriefingUrl}` : text,
  };
}

function buildReferenceEntityMap(gather: BriefingGather): Map<BriefingReference, ReferenceEntity> {
  const entities = new Map<BriefingReference, ReferenceEntity>();

  for (const items of Object.values(gather.email.categories)) {
    for (const item of items ?? []) {
      const reference = briefingReference("email", item.documentId);
      entities.set(reference, {
        reference,
        label: item.subject,
        source: "email",
        href: item.threadId ? gmailThreadUrl(item.threadId) : undefined,
      });
    }
  }

  for (const item of gather.integration_activity.items) {
    const reference = briefingReference("activity", item.id);
    entities.set(reference, {
      reference,
      label: item.title,
      source: "integration_activity",
      href: item.url,
    });
  }

  for (const event of gather.calendar?.events ?? []) {
    const reference = briefingReference("meeting", event.eventId);
    entities.set(reference, {
      reference,
      label: event.title,
      source: "calendar",
    });
  }

  return entities;
}

function emailPanelItems(
  gather: BriefingGather,
  referenced: ReadonlySet<BriefingReference>,
): BriefingSourcePanelItem[] {
  const items: BriefingSourcePanelItem[] = [];
  for (const [category, categoryItems] of Object.entries(gather.email.categories)) {
    for (const item of categoryItems ?? []) {
      items.push({
        id: item.documentId,
        title: item.subject,
        subtitle: item.sender,
        href: item.threadId ? gmailThreadUrl(item.threadId) : undefined,
        reference: briefingReference("email", item.documentId),
        metadata: compactMetadata({
          category,
          snippet: item.snippet,
          referenced: referenced.has(briefingReference("email", item.documentId))
            ? "true"
            : undefined,
        }),
      });
    }
  }
  return items;
}

function prioritizeReferenced(
  items: BriefingSourcePanelItem[],
  referenced: ReadonlySet<BriefingReference>,
): BriefingSourcePanelItem[] {
  return [...items].sort((a, b) => {
    const aHit = isReferenced(a.reference, referenced) ? 1 : 0;
    const bHit = isReferenced(b.reference, referenced) ? 1 : 0;
    return bHit - aHit;
  });
}

function rawReferenceFromMatch(match: RegExpMatchArray): string {
  return `${match[1] ?? ""}:${match[2] ?? ""}`;
}

function parseBriefingReferenceString(value: string): ParsedBriefingReference | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return parseBriefingReference(kind, id);
}

function parseBriefingReference(
  kind: string,
  id: string | undefined,
): ParsedBriefingReference | null {
  if (!id || !isBriefingReferenceKind(kind)) return null;
  return {
    kind,
    id,
    reference: briefingReference(kind, id),
  };
}

function isBriefingReferenceKind(value: string): value is BriefingReferenceKind {
  return BRIEFING_REFERENCE_KIND_SET.has(value);
}

function briefingReference(kind: BriefingReferenceKind, id: string): BriefingReference {
  return `${kind}:${id}` as BriefingReference;
}

function isReferenced(
  reference: string | undefined,
  referenced: ReadonlySet<BriefingReference>,
): boolean {
  if (!reference) return false;
  const parsed = parseBriefingReferenceString(reference);
  return parsed ? referenced.has(parsed.reference) : false;
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function integrationSubtitle(provider: string, providerKind: string, relatedRepo?: string): string {
  const kind = providerKind.replaceAll("_", " ");
  return relatedRepo ? `${provider} · ${relatedRepo} · ${kind}` : `${provider} · ${kind}`;
}

function formatDateRange(start: string, end: string): string {
  if (!start || !end) return start || end;
  return `${start} - ${end}`;
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function renderSegmentsText(segments: BriefingSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      return segment.href ? `${segment.label} (${segment.href})` : segment.label;
    })
    .join("");
}

function renderSegmentsHtml(segments: BriefingSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === "text") return escapeHtml(segment.text).replace(/\n/g, "<br />");
      const label = escapeHtml(segment.label);
      if (!segment.href) return `<span>${label}</span>`;
      return `<a href="${escapeHtml(segment.href)}" style="${EMAIL_LINK_STYLE}">${label}</a>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EMAIL_WRAPPER_STYLE =
  'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; color: #1a1a1a; line-height: 1.5;';
const EMAIL_P_STYLE = "margin: 0 0 16px 0; font-size: 15px;";
const EMAIL_LINK_STYLE = "color: #2563eb; text-decoration: none;";
