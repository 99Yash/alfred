import {
  collapseWhitespace,
  isToolName,
  jsonObjectSchema,
  toFiniteNumber,
  toNonEmptyString,
  type DocumentSource,
  type JsonObject,
  type ToolName,
} from "@alfred/contracts";
import type { LucideIcon } from "lucide-react";
import { domainOf } from "~/lib/favicon";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { formatRelative } from "~/lib/date-format";
import { brandlessToolIcon } from "./animated-tool-icons";
import { toSource, type Source } from "./sources";
import type { ResolvedToolCall } from "~/lib/chat/resolved-tool-call";

/** The two live-web tools. `satisfies ToolName` makes a rename fail to compile here. */
const WEB_SEARCH_TOOL = "system.web_search" satisfies ToolName;

const FETCH_URL_TOOL = "system.fetch_url" satisfies ToolName;

export interface FetchUrlView {
  kind: "fetch_url";
  /** Hostname of the page, after redirects once it lands. */
  domain: string;
  title?: string | undefined;
  /** The final URL after redirects, else the requested one. */
  href: string;
  excerpt?: string | undefined;
}

export interface WebSearchView {
  kind: "web_search";
  query?: string | undefined;
  sources: Source[];
}

export type BrowsingView = FetchUrlView | WebSearchView;

/**
 * Display shape for a browsing tool call. Previews are best-effort JSON, so a bad one gives less detail, not an error.
 * `null` for a non-browsing tool.
 */
export function presentBrowsing(tool: ResolvedToolCall): BrowsingView | null {
  const { args, result } = tool;

  if (tool.toolName === FETCH_URL_TOOL) {
    // Only `url` exists while the fetch is in flight.
    const finalUrl = toNonEmptyString(result?.finalUrl);
    const requested = toNonEmptyString(result?.url) ?? toNonEmptyString(args?.url);
    const href = finalUrl ?? requested;

    if (!href) return null;
    const text = toNonEmptyString(result?.text);

    return {
      kind: "fetch_url",
      domain: domainOf(href),
      title: toNonEmptyString(result?.title),
      href,
      excerpt: text ? collapseWhitespace(text).slice(0, 400) : undefined,
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
      query: searchQueryOf(tool),
      sources: [...byDomain.values()],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Integration evidence: a record list or entity card for read tools, built from
// the same `resultPreview` as the JSON dump. A tool with no spec keeps the dump.
// ---------------------------------------------------------------------------

/** A status pill. Tones map to `app-*` scales. */
export interface EvidenceBadge {
  label: string;
  tone: "neutral" | "green" | "red" | "amber" | "purple";
}

interface EvidenceRow {
  /** The record's url or id, else its title. */
  key: string;
  title: string;
  href?: string | undefined;
  meta?: string | undefined;
  badge?: EvidenceBadge | undefined;
  /** Per-row glyph when a list spans services. Beats {@link faviconDomain}: a real logo. */
  brand?: IntegrationBrand | undefined;
  faviconDomain?: string | undefined;
  /** Glyph for a row from no service (a `system.*` tool). Last choice. */
  icon?: LucideIcon | undefined;
}

export interface RecordListView {
  kind: "record-list";
  /** Favicon for every row. Absent when rows carry their own glyphs. */
  faviconDomain?: string | undefined;
  query?: string | undefined;
  rows: EvidenceRow[];
  /** `totalCount − shown`. */
  remaining?: number | undefined;
  /** More exist, count unknown. */
  hasMore?: boolean | undefined;
}

/** "3d ago" for a real ISO string; anything else gives no meta. */
function ago(value: unknown): string | undefined {
  const iso = toNonEmptyString(value);

  return iso ? formatRelative(iso) : undefined;
}

function joinMeta(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));

  return kept.length > 0 ? kept.join(" · ") : undefined;
}

/** Tools whose query is a search intent, for the subline. An allowlist: other tools have a `query` too. */
const SEARCH_TOOLS = new Set<ToolName>([
  "system.search_tools" satisfies ToolName,
  "system.corpus_search" satisfies ToolName,
  "system.search_context" satisfies ToolName,
  "system.web_search" satisfies ToolName,
  "system.read_chat_history" satisfies ToolName,
]);

/**
 * Live args first, then the result echo.
 * `argsPreview` is dropped on persist, so after reload only an echoed query survives.
 */
export function searchQueryOf(tool: ResolvedToolCall): string | undefined {
  if (!tool.registeredName || !SEARCH_TOOLS.has(tool.registeredName)) return undefined;
  const { args, result } = tool;

  return toNonEmptyString(args?.query) ?? toNonEmptyString(result?.query);
}

function brandOfToolName(name: string | undefined): IntegrationBrand | undefined {
  if (!name) return undefined;
  const slug = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;

  return getIntegrationPage(slug)?.brand;
}

/**
 * Exhaustive over `DocumentSource`, so a new lane fails typecheck instead of a blank chip.
 * `gmail_attachment` uses the Gmail mark.
 */
const DOCUMENT_SOURCE_BRANDS = {
  gmail: "gmail",
  gmail_attachment: "gmail",
  github: "github",
} satisfies Record<DocumentSource, IntegrationBrand>;

/** Keyed by string: `source` comes from a parsed preview, so an unknown lane gets no glyph. */
const DOCUMENT_SOURCE_BRAND_BY_KEY: ReadonlyMap<string, IntegrationBrand> = new Map(
  Object.entries(DOCUMENT_SOURCE_BRANDS),
);

function brandOfDocumentSource(source: string | undefined): IntegrationBrand | undefined {
  return source ? DOCUMENT_SOURCE_BRAND_BY_KEY.get(source) : undefined;
}

/** A `record-list` spec: where the records live and how to build each row. */
interface ListSpec {
  arrayKey: string;
  /** List-wide favicon. Omit it when rows span services. */
  faviconDomain?: string | undefined;
  row: (item: JsonObject) => EvidenceRow | null;
  /** Exact count beyond the shown rows. */
  remaining?: ((result: JsonObject, shown: number) => number | undefined) | undefined;
  hasMore?: ((result: JsonObject) => boolean) | undefined;
}

const LIST_SPECS = new Map<ToolName, ListSpec>([
  [
    // Hits come from every lane, so each wears its own source's mark.
    "system.corpus_search",
    {
      arrayKey: "hits",
      row: (item) => {
        const title = toNonEmptyString(item.title);

        if (!title) return null;
        const page = toFiniteNumber(item.page);

        return {
          key: toNonEmptyString(item.chunkId) ?? toNonEmptyString(item.documentId) ?? title,
          title,
          href: toNonEmptyString(item.url),
          // The page number is proved by the extractor and never invented by the model (ADR-0091).
          meta: joinMeta(page ? `page ${page}` : undefined, ago(item.authoredAt)),
          brand: brandOfDocumentSource(toNonEmptyString(item.source)),
        };
      },
    },
  ],
  [
    "system.search_tools",
    {
      arrayKey: "candidates",
      row: (item) => {
        const name = toNonEmptyString(item.name);

        if (!name) return null;
        const unavailable = toNonEmptyString(item.unavailableReason);

        return {
          key: name,
          title: toNonEmptyString(item.title) ?? name,
          meta: name,
          brand: brandOfToolName(name),
          // A `system.*` tool has no service, so use its trail icon.
          icon: brandlessToolIcon(isToolName(name) ? name : undefined),
          // Explains a search that found a tool and then did nothing.
          badge: unavailable ? { label: "unavailable", tone: "amber" } : undefined,
        };
      },
    },
  ],
]);

/** A record list for a read tool. `null` keeps the JSON dump. */
export function presentEvidence(tool: ResolvedToolCall): RecordListView | null {
  const { result, registeredName } = tool;

  if (!result || !registeredName) return null;

  const listSpec = LIST_SPECS.get(registeredName);

  if (listSpec) {
    const raw = result[listSpec.arrayKey];

    if (!Array.isArray(raw) || raw.length === 0) return null;
    const rows: EvidenceRow[] = [];

    for (const entry of raw) {
      const record = jsonObjectSchema.safeParse(entry);

      if (!record.success) continue;
      const row = listSpec.row(record.data);

      if (row) rows.push(row);
    }

    if (rows.length === 0) return null;

    return {
      kind: "record-list",
      faviconDomain: listSpec.faviconDomain,
      query: searchQueryOf(tool),
      rows,
      remaining: listSpec.remaining?.(result, rows.length),
      hasMore: listSpec.hasMore?.(result) ?? false,
    };
  }

  return null;
}
