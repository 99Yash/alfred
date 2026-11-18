import { getStringPath, isNonEmptyString } from "@alfred/contracts";
import type { ResolvedToolCall } from "~/lib/chat/resolved-tool-call";
import { domainOf } from "~/lib/favicon";

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

  const href = getStringPath(citation, "url");

  if (!href) return null;
  const title = getStringPath(citation, "title")?.trim() ?? "";
  const hostFallback = domainOf(href);

  return {
    label: title || hostFallback,
    faviconDomain: title && looksLikeDomain(title) ? title : hostFallback,
    href,
  };
}

/**
 * Every web page in a turn, deduped by publisher in first-seen order. Best-effort. A
 * `system.code_run` script's pages come from `scriptSources`, which the preview does not prune
 * (ADR-0124). The host sets it only for reads that executed, so a failed script keeps them. A
 * direct web read's pages come from its parsed result, and only when it succeeded.
 */
export function collectSources(tools: readonly ResolvedToolCall[]): Source[] {
  const byKey = new Map<string, Source>();

  for (const tool of tools) {
    const citations =
      tool.scriptSources?.sources ??
      (tool.status === "succeeded" ? tool.result?.citations : undefined);

    if (!Array.isArray(citations)) continue;

    for (const citation of citations) {
      const source = toSource(citation);

      if (source && !byKey.has(source.faviconDomain)) byKey.set(source.faviconDomain, source);
    }
  }

  return [...byKey.values()];
}
