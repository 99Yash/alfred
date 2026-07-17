import type { ToolName } from "@alfred/contracts";
import { domainOf } from "~/lib/favicon";
import { asString, parseJsonRecord } from "~/lib/json-record";
import { toSource, type Source } from "./sources";
import type { ToolCallView } from "./tool-call-presentation";

/**
 * The two system tools that read the live web. Everything about a "browsing"
 * card — the site favicon on the coin, the domain subline, the rich result
 * list instead of a raw JSON dump — is gated on this. `satisfies ToolName`
 * pins each to the canonical contracts key, so a rename there fails to compile
 * here instead of leaving these literals silently wrong.
 */
export const WEB_SEARCH_TOOL = "system.web_search" satisfies ToolName;
export const FETCH_URL_TOOL = "system.fetch_url" satisfies ToolName;

export function isBrowsingTool(toolName: string): boolean {
  return toolName === WEB_SEARCH_TOOL || toolName === FETCH_URL_TOOL;
}

export interface FetchUrlView {
  kind: "fetch_url";
  /** Bare hostname of the page being read (post-redirect once it lands). */
  domain: string;
  /** The page `<title>`, once the fetch succeeds. */
  title?: string;
  /** Where the card links: the final URL after redirects, else the requested one. */
  href: string;
  /** A short peek at the sanitized text the fetch pulled back, for the panel. */
  excerpt?: string;
}

export interface WebSearchView {
  kind: "web_search";
  /** The search query, shown as the card's subline. */
  query?: string;
  /** Deduped result sources (favicon + title + host), once the search lands. */
  sources: Source[];
}

export type BrowsingView = FetchUrlView | WebSearchView;

/**
 * Read the display shape out of a browsing tool call's args + result preview.
 * Both are best-effort JSON (pruned/sanitized server-side), so every field is
 * optional and a malformed preview simply yields less detail, never an error.
 * Returns `null` for a non-browsing tool so the caller keeps its normal card.
 */
export function presentBrowsing(tool: ToolCallView): BrowsingView | null {
  const args = parseJsonRecord(tool.argsPreview);
  const result = parseJsonRecord(tool.resultPreview);

  if (tool.toolName === FETCH_URL_TOOL) {
    // Prefer the post-redirect `finalUrl` from the result; fall back to the
    // requested `url` (the only thing we have while the fetch is in flight).
    const finalUrl = asString(result?.finalUrl);
    const requested = asString(result?.url) ?? asString(args?.url);
    const href = finalUrl ?? requested;
    if (!href) return null;
    const text = asString(result?.text);
    return {
      kind: "fetch_url",
      domain: domainOf(href),
      title: asString(result?.title),
      href,
      excerpt: text ? text.replace(/\s+/g, " ").trim().slice(0, 400) : undefined,
    };
  }

  if (tool.toolName === WEB_SEARCH_TOOL) {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const byDomain = new Map<string, Source>();
    for (const citation of citations) {
      const source = toSource(citation);
      if (source && !byDomain.has(source.faviconDomain)) {
        byDomain.set(source.faviconDomain, source);
      }
    }
    return {
      kind: "web_search",
      // `argsPreview` is dropped from the persisted call, so the query only
      // survives on reload via the result echo — read args first (live), then
      // fall back to `result.query` (persisted).
      query: asString(args?.query) ?? asString(result?.query),
      sources: [...byDomain.values()],
    };
  }

  return null;
}
