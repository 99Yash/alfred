import { getStringPath, isNonEmptyString } from "@alfred/contracts";
import { asRecord, parseJsonRecord } from "~/lib/json-record";
import { domainOf } from "~/lib/favicon";
import type { ToolCallView } from "./tool-call-presentation";

export interface Source {
  /** Publisher name: the domain or the page title. */
  label: string;
  /** Hostname for the favicon. */
  faviconDomain: string;
  /** The first URL seen for this publisher. */
  href: string;
}

/** A bare hostname like "cloudflare.com". */
function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

/**
 * One citation as a source. Web search's `url` is a vertex redirect and `title` is the publisher domain,
 * so prefer `title`. Old messages store a plain string.
 */
export function toSource(citation: unknown): Source | null {
  if (isNonEmptyString(citation)) {
    const domain = domainOf(citation);

    return { label: domain, faviconDomain: domain, href: citation };
  }

  const record = asRecord(citation);
  const href = getStringPath(record, "url");

  if (!href) return null;
  const title = getStringPath(record, "title")?.trim() ?? "";
  const hostFallback = domainOf(href);

  return {
    label: title || hostFallback,
    faviconDomain: title && looksLikeDomain(title) ? title : hostFallback,
    href,
  };
}

/** Every web-search citation in a turn, deduped by publisher in first-seen order. Best-effort. */
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
