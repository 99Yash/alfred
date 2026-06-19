import {
  briefingReference,
  type BriefingReference,
  type BriefingSegment,
  type BriefingSourcePanel,
  type BriefingSourcePanelItem,
  gmailThreadUrl,
  parseBriefingReference,
} from "@alfred/contracts";
import type { BriefingGather } from "@alfred/contracts";

// The pure resolver (resolveBriefingReferences, referencesFromSections,
// listBriefingReferenceOptions, parseBriefingReference, BriefingSegment, …)
// relocated to @alfred/contracts so the web surface can resolve synced prose
// against the synced gather without importing @alfred/api (ADR-0049). Re-export
// it here so existing @alfred/api consumers keep their import path. The source
// panels builder and the email HTML renderer stay server-side below.
export {
  type BriefingReference,
  type BriefingReferenceOption,
  type BriefingSegment,
  listBriefingReferenceOptions,
  type ParsedBriefingReference,
  parseBriefingReference,
  referencesFromSections,
  resolveBriefingReferences,
  type ResolveBriefingReferencesResult,
} from "@alfred/contracts";

export interface RenderBriefingEmailArgs {
  segments: BriefingSegment[];
  fullBriefingUrl?: string;
}

export interface RenderedBriefingEmail {
  html: string;
  text: string;
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

function isReferenced(
  reference: string | undefined,
  referenced: ReadonlySet<BriefingReference>,
): boolean {
  if (!reference) return false;
  const parsed = parseBriefingReference(reference);
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

export function escapeHtml(s: string): string {
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
