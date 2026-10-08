import {
  collapseWhitespace,
  githubSearchResultSchema,
  GOOGLE_WORKSPACE_MIME_PREFIX,
  INTEGRATIONS,
  isToolName,
  type DocumentSource,
  type ToolName,
} from "@alfred/contracts";
import type { LucideIcon } from "lucide-react";
import { domainOf } from "~/lib/favicon";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import { formatRelative } from "~/lib/strings";
import { asRecord, asNumber, asString, parseJsonRecord, type JsonRecord } from "~/lib/json-record";
import { brandlessToolIcon } from "./animated-tool-icons";
import { toSource, type Source } from "./sources";
import type { ToolCallView } from "./tool-call-presentation";

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
export function presentBrowsing(tool: ToolCallView): BrowsingView | null {
  const args = parseJsonRecord(tool.argsPreview);
  const result = parseJsonRecord(tool.resultPreview);

  if (tool.toolName === FETCH_URL_TOOL) {
    // Only `url` exists while the fetch is in flight.
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

interface EntityFact {
  label: string;
  value: string;
}

/** A single object a read tool returned (a PR, an email, an issue). */
export interface EntityView {
  kind: "entity";
  faviconDomain: string;
  title: string;
  href?: string | undefined;
  badge?: EvidenceBadge | undefined;
  facts: EntityFact[];
  excerpt?: string | undefined;
}

/** "3d ago" for a real ISO string; anything else gives no meta. */
function ago(value: unknown): string | undefined {
  const iso = asString(value);

  return iso ? formatRelative(iso) : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Read the wall clock straight from the offset ISO string, not through `Date`.
 * Calendar events then show their scheduled time, not the viewer's zone.
 */
function formatEventWindow(startIso: string, endIso?: string): string {
  const start = parseWallClock(startIso);

  if (!start) return startIso;
  const day = `${MONTHS[start.month - 1]} ${start.day}`;
  const end = endIso ? parseWallClock(endIso) : null;

  return end ? `${day}, ${clock12(start)} – ${clock12(end)}` : `${day}, ${clock12(start)}`;
}

interface WallClock {
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseWallClock(iso: string): WallClock | null {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);

  if (!m) return null;

  return { month: Number(m[1]), day: Number(m[2]), hour: Number(m[3]), minute: Number(m[4]) };
}

function clock12({ hour, minute }: WallClock): string {
  const period = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;

  return minute === 0 ? `${h} ${period}` : `${h}:${String(minute).padStart(2, "0")} ${period}`;
}

function githubStateBadge(item: JsonRecord): EvidenceBadge | undefined {
  if (item.draft === true) return { label: "Draft", tone: "neutral" };
  const state = asString(item.state);

  if (state === "open") return { label: "Open", tone: "green" };

  if (item.merged === true) return { label: "Merged", tone: "purple" };

  if (state === "closed") return { label: "Closed", tone: "red" };

  return undefined;
}

/** Drive MIME type to a short kind ("PDF", "Doc", "Folder"). */
function driveKind(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;

  if (mimeType === `${GOOGLE_WORKSPACE_MIME_PREFIX}folder`) return "Folder";

  if (mimeType === `${GOOGLE_WORKSPACE_MIME_PREFIX}document`) return "Doc";

  if (mimeType === `${GOOGLE_WORKSPACE_MIME_PREFIX}spreadsheet`) return "Sheet";

  if (mimeType === `${GOOGLE_WORKSPACE_MIME_PREFIX}presentation`) return "Slides";

  if (mimeType === "application/pdf") return "PDF";
  const sub = mimeType.split("/")[1];

  return sub ? sub.toUpperCase() : undefined;
}

function joinMeta(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));

  return kept.length > 0 ? kept.join(" · ") : undefined;
}

function snippetOf(text: string | undefined, max = 300): string | undefined {
  if (!text) return undefined;
  const collapsed = collapseWhitespace(text);

  return collapsed ? collapsed.slice(0, max) : undefined;
}

/** `gmail.read_message` stores raw RFC822 in `content`, so drop the headers up to the first blank line. */
function emailBody(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const blank = content.indexOf("\n\n");

  return snippetOf(blank >= 0 ? content.slice(blank + 2) : content);
}

/** Tools whose query is a search intent, for the subline. An allowlist: other tools have a `query` too. */
const SEARCH_TOOLS = new Set<ToolName>([
  "system.search_tools" satisfies ToolName,
  "system.corpus_search" satisfies ToolName,
  "system.search_context" satisfies ToolName,
  "system.web_search" satisfies ToolName,
  "system.read_chat_history" satisfies ToolName,
  "gmail.search" satisfies ToolName,
  "github.search" satisfies ToolName,
  "notion.search" satisfies ToolName,
  "drive.search_files" satisfies ToolName,
]);

/**
 * Live args first, then the result echo.
 * `argsPreview` is dropped on persist, so after reload only an echoed query survives.
 */
export function searchQueryOf(tool: ToolCallView): string | undefined {
  if (!isToolName(tool.toolName) || !SEARCH_TOOLS.has(tool.toolName)) return undefined;
  const args = parseJsonRecord(tool.argsPreview);
  const result = parseJsonRecord(tool.resultPreview);

  // Gmail names it `q`.
  return asString(args?.query) ?? asString(args?.q) ?? asString(result?.query);
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
  sentry: "sentry",
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
  row: (item: JsonRecord) => EvidenceRow | null;
  /** Exact count beyond the shown rows. */
  remaining?: ((result: JsonRecord, shown: number) => number | undefined) | undefined;
  hasMore?: ((result: JsonRecord) => boolean) | undefined;
}

const LIST_SPECS = new Map<ToolName, ListSpec>([
  [
    // Hits come from every lane, so each wears its own source's mark.
    "system.corpus_search",
    {
      arrayKey: "hits",
      row: (item) => {
        const title = asString(item.title);

        if (!title) return null;
        const page = asNumber(item.page);

        return {
          key: asString(item.chunkId) ?? asString(item.documentId) ?? title,
          title,
          href: asString(item.url),
          // The page number is proved by the extractor and never invented by the model (ADR-0091).
          meta: joinMeta(page ? `page ${page}` : undefined, ago(item.authoredAt)),
          brand: brandOfDocumentSource(asString(item.source)),
        };
      },
    },
  ],
  [
    "system.search_tools",
    {
      arrayKey: "candidates",
      row: (item) => {
        const name = asString(item.name);

        if (!name) return null;
        const unavailable = asString(item.unavailableReason);

        return {
          key: name,
          title: asString(item.title) ?? name,
          meta: name,
          brand: brandOfToolName(name),
          // A `system.*` tool has no service, so use its trail icon.
          icon: brandlessToolIcon(name),
          // Explains a search that found a tool and then did nothing.
          badge: unavailable ? { label: "unavailable", tone: "amber" } : undefined,
        };
      },
    },
  ],
  [
    "gmail.search",
    {
      arrayKey: "messages",
      faviconDomain: INTEGRATIONS.gmail.domain,
      hasMore: (result) => asString(result.nextPageToken) !== undefined,
      row: (item) => {
        const subject = asString(item.subject);
        const from = asString(item.from);

        if (!subject && !from) return null;

        return {
          key: asString(item.messageId) ?? subject ?? from ?? "message",
          title: subject ?? "(no subject)",
          href: asString(item.url),
          meta: joinMeta(from, ago(item.authoredAt)),
        };
      },
    },
  ],
  [
    "github.search",
    {
      arrayKey: "items",
      faviconDomain: INTEGRATIONS.github.domain,
      remaining: (result, shown) => {
        // The preview has only the first page; `totalCount` gives the "+N". No count, no "+N".
        const parsed = githubSearchResultSchema.safeParse(result);

        if (!parsed.success) return undefined;

        return parsed.data.totalCount > shown ? parsed.data.totalCount - shown : undefined;
      },
      row: (item) => {
        const title = asString(item.title);

        if (!title) return null;
        const number = asNumber(item.number);
        const url = asString(item.url);

        return {
          key: url ?? String(number ?? title),
          title: number ? `#${number} ${title}` : title,
          href: url,
          meta: asString(item.repository),
          badge: githubStateBadge(item),
        };
      },
    },
  ],
  [
    "github.get_pull_requests",
    {
      arrayKey: "items",
      faviconDomain: INTEGRATIONS.github.domain,
      row: (item) => {
        const title = asString(item.title);

        if (!title) return null;
        const number = asNumber(item.number);
        const url = asString(item.url);
        const additions = asNumber(item.additions);
        const deletions = asNumber(item.deletions);

        const diff =
          additions !== undefined || deletions !== undefined
            ? `+${additions ?? 0} −${deletions ?? 0}`
            : undefined;

        return {
          key: url ?? String(number ?? title),
          title: number ? `#${number} ${title}` : title,
          href: url,
          meta: joinMeta(asString(item.repository), diff),
          badge: githubStateBadge(item),
        };
      },
    },
  ],
  [
    "calendar.list_events",
    {
      arrayKey: "events",
      faviconDomain: INTEGRATIONS.calendar.domain,
      row: (item) => {
        const title = asString(item.title);

        if (!title) return null;
        const start = asString(item.start);
        // Google sends an absent location as the string "null".
        const location = asString(item.location);

        return {
          key: asString(item.id) ?? title,
          title,
          href: asString(item.htmlLink) ?? asString(item.hangoutLink),
          meta: joinMeta(
            start ? formatEventWindow(start, asString(item.end)) : undefined,
            location && location !== "null" ? location : undefined,
          ),
        };
      },
    },
  ],
  [
    "notion.search",
    {
      arrayKey: "hits",
      faviconDomain: INTEGRATIONS.notion.domain,
      hasMore: (result) => result.hasMore === true,
      row: (item) => {
        const title = asString(item.title);

        if (!title) return null;

        return {
          key: asString(item.id) ?? title,
          title,
          href: asString(item.url),
          meta: ago(item.lastEditedTime),
        };
      },
    },
  ],
  [
    "drive.search_files",
    {
      arrayKey: "files",
      faviconDomain: INTEGRATIONS.drive.domain,
      row: (item) => {
        const name = asString(item.name);

        if (!name) return null;

        return {
          key: asString(item.id) ?? name,
          title: name,
          href: asString(item.webViewLink),
          meta: joinMeta(driveKind(asString(item.mimeType)), ago(item.modifiedTime)),
        };
      },
    },
  ],
]);

function githubEntity(result: JsonRecord): EntityView | null {
  const title = asString(result.title);

  if (!title) return null;
  const number = asNumber(result.number);
  const facts: EntityFact[] = [];
  const repo = asString(result.repository);

  if (repo) facts.push({ label: "Repo", value: repo });
  const author = asString(result.author);

  if (author) facts.push({ label: "Author", value: author });
  const additions = asNumber(result.additions);
  const deletions = asNumber(result.deletions);

  if (additions !== undefined || deletions !== undefined) {
    facts.push({ label: "Diff", value: `+${additions ?? 0} −${deletions ?? 0}` });
  }

  const commits = asNumber(result.commits);

  if (commits !== undefined) facts.push({ label: "Commits", value: String(commits) });
  const changedFiles = asNumber(result.changedFiles);

  if (changedFiles !== undefined) facts.push({ label: "Files", value: String(changedFiles) });
  // PR previews have no comment count or body.
  const comments = asNumber(result.comments);

  if (comments !== undefined) facts.push({ label: "Comments", value: String(comments) });

  return {
    kind: "entity",
    faviconDomain: INTEGRATIONS.github.domain,
    title: number ? `#${number} ${title}` : title,
    href: asString(result.url),
    badge: githubStateBadge(result),
    facts,
    excerpt: snippetOf(asString(result.body)),
  };
}

const ENTITY_BUILDERS = new Map<ToolName, (result: JsonRecord) => EntityView | null>([
  ["github.get_pull_request", githubEntity],
  ["github.get_issue", githubEntity],
  [
    "gmail.read_message",
    (result) => {
      const subject = asString(result.subject);
      // Newer reads put `from`/`to`/`snippet` at the top level; older ones under `metadata`.
      const metadata = asRecord(result.metadata);
      const from = asString(result.from) ?? (metadata ? asString(metadata.from) : undefined);
      const to = asString(result.to) ?? (metadata ? asString(metadata.to) : undefined);

      if (!subject && !from) return null;
      const facts: EntityFact[] = [];

      if (from) facts.push({ label: "From", value: from });

      if (to) facts.push({ label: "To", value: to });
      const date = ago(result.authoredAt);

      if (date) facts.push({ label: "Date", value: date });
      const snippet = metadata ? asString(metadata.snippet) : undefined;

      return {
        kind: "entity",
        faviconDomain: INTEGRATIONS.gmail.domain,
        title: subject ?? "(no subject)",
        // Often null for Gmail reads.
        href: asString(result.url),
        facts,
        excerpt: snippet ?? emailBody(asString(result.content)),
      };
    },
  ],
]);

/** A record list or entity for a read tool. `null` keeps the JSON dump. */
export function presentEvidence(tool: ToolCallView): RecordListView | EntityView | null {
  const result = parseJsonRecord(tool.resultPreview);

  if (!result || !isToolName(tool.toolName)) return null;

  const listSpec = LIST_SPECS.get(tool.toolName);

  if (listSpec) {
    const raw = result[listSpec.arrayKey];

    if (!Array.isArray(raw) || raw.length === 0) return null;
    const rows: EvidenceRow[] = [];

    for (const entry of raw) {
      const record = asRecord(entry);

      if (!record) continue;
      const row = listSpec.row(record);

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

  const entityBuilder = ENTITY_BUILDERS.get(tool.toolName);

  if (entityBuilder) return entityBuilder(result);

  return null;
}
