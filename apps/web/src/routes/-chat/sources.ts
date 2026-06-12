import { asRecord, parseJsonRecord } from "~/lib/json-record";
import { domainOf } from "~/lib/favicon";
import type { ToolCallView } from "./tool-call-presentation";

export interface Source {
  /** Publisher name shown on the chip (real domain, or page title). */
  label: string;
  /** Bare hostname used for the favicon lookup. */
  faviconDomain: string;
  /** The first URL seen for this publisher — where the chip links. */
  href: string;
}

/** A bare hostname like "cloudflare.com" — not a page title or a full URL. */
function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

/**
 * Normalize one citation into a display source. Web search returns
 * `{ url, title }` where `url` is a vertex grounding redirect and `title` is
 * the real publisher domain — so favicon + label come from `title` when it's
 * present, falling back to the url's host. Tolerates the legacy `string`
 * citation shape persisted on older messages.
 */
function toSource(citation: unknown): Source | null {
  if (typeof citation === "string") {
    if (citation.length === 0) return null;
    const domain = domainOf(citation);
    return { label: domain, faviconDomain: domain, href: citation };
  }
  const record = asRecord(citation);
  const href = typeof record?.url === "string" ? record.url : undefined;
  if (!href) return null;
  const title = typeof record?.title === "string" ? record.title.trim() : "";
  const hostFallback = domainOf(href);
  return {
    label: title || hostFallback,
    faviconDomain: title && looksLikeDomain(title) ? title : hostFallback,
    href,
  };
}

/**
 * Gather every web-search citation a turn produced, deduped by publisher in
 * first-seen order. Web-search tool results land on the client inside each
 * call's `resultPreview` (`{ ok, query, answer, citations }`, pruned to valid
 * JSON server-side). Extraction is best-effort — a missing or odd-shaped
 * preview just yields no sources, never an error.
 */
export function collectSources(tools: ToolCallView[]): Source[] {
  const byKey = new Map<string, Source>();
  for (const tool of tools) {
    if (tool.status !== "succeeded") continue;
    const result = parseJsonRecord(tool.resultPreview);
    const citations = result?.citations;
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      const source = toSource(citation);
      if (source && !byKey.has(source.faviconDomain)) byKey.set(source.faviconDomain, source);
    }
  }
  return [...byKey.values()];
}
