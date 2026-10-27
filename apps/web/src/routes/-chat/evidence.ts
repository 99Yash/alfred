import {
  collapseWhitespace,
  githubSearchResultSchema,
  GOOGLE_WORKSPACE_MIME_PREFIX,
  INTEGRATIONS,
  getPath,
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
import { formatRelative } from "~/lib/strings";
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
  const iso = toNonEmptyString(value);

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

function githubStateBadge(item: JsonObject): EvidenceBadge | undefined {
  if (item.draft === true) return { label: "Draft", tone: "neutral" };
  const state = toNonEmptyString(item.state);

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
  "drive.search_files" satisfies ToolName,
]);

/**
 * Live args first, then the result echo.
 * `argsPreview` is dropped on persist, so after reload only an echoed query survives.
 */
export function searchQueryOf(tool: ResolvedToolCall): string | undefined {
  if (!tool.registeredName || !SEARCH_TOOLS.has(tool.registeredName)) return undefined;
  const { args, result } = tool;

  // Gmail names it `q`.
  return (
    toNonEmptyString(args?.query) ?? toNonEmptyString(args?.q) ?? toNonEmptyString(result?.query)
  );
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
  [
    "gmail.search",
    {
      arrayKey: "messages",
      faviconDomain: INTEGRATIONS.gmail.domain,
      hasMore: (result) => toNonEmptyString(result.nextPageToken) !== undefined,
      row: (item) => {
        const subject = toNonEmptyString(item.subject);
        const from = toNonEmptyString(item.from);

        if (!subject && !from) return null;

        return {
          key: toNonEmptyString(item.messageId) ?? subject ?? from ?? "message",
          title: subject ?? "(no subject)",
          href: toNonEmptyString(item.url),
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
        const title = toNonEmptyString(item.title);

        if (!title) return null;
        const number = toFiniteNumber(item.number);
        const url = toNonEmptyString(item.url);

        return {
          key: url ?? String(number ?? title),
          title: number ? `#${number} ${title}` : title,
          href: url,
          meta: toNonEmptyString(item.repository),
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
        const title = toNonEmptyString(item.title);

        if (!title) return null;
        const number = toFiniteNumber(item.number);
        const url = toNonEmptyString(item.url);
        const additions = toFiniteNumber(item.additions);
        const deletions = toFiniteNumber(item.deletions);

        const diff =
          additions !== undefined || deletions !== undefined
            ? `+${additions ?? 0} −${deletions ?? 0}`
            : undefined;

        return {
          key: url ?? String(number ?? title),
          title: number ? `#${number} ${title}` : title,
          href: url,
          meta: joinMeta(toNonEmptyString(item.repository), diff),
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
        const title = toNonEmptyString(item.title);

        if (!title) return null;
        const start = toNonEmptyString(item.start);
        // Google sends an absent location as the string "null".
        const location = toNonEmptyString(item.location);

        return {
          key: toNonEmptyString(item.id) ?? title,
          title,
          href: toNonEmptyString(item.htmlLink) ?? toNonEmptyString(item.hangoutLink),
          meta: joinMeta(
            start ? formatEventWindow(start, toNonEmptyString(item.end)) : undefined,
            location && location !== "null" ? location : undefined,
          ),
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
        const name = toNonEmptyString(item.name);

        if (!name) return null;

        return {
          key: toNonEmptyString(item.id) ?? name,
          title: name,
          href: toNonEmptyString(item.webViewLink),
          meta: joinMeta(driveKind(toNonEmptyString(item.mimeType)), ago(item.modifiedTime)),
        };
      },
    },
  ],
]);

function githubEntity(result: JsonObject): EntityView | null {
  const title = toNonEmptyString(result.title);

  if (!title) return null;
  const number = toFiniteNumber(result.number);
  const facts: EntityFact[] = [];
  const repo = toNonEmptyString(result.repository);

  if (repo) facts.push({ label: "Repo", value: repo });
  const author = toNonEmptyString(result.author);

  if (author) facts.push({ label: "Author", value: author });
  const additions = toFiniteNumber(result.additions);
  const deletions = toFiniteNumber(result.deletions);

  if (additions !== undefined || deletions !== undefined) {
    facts.push({ label: "Diff", value: `+${additions ?? 0} −${deletions ?? 0}` });
  }

  const commits = toFiniteNumber(result.commits);

  if (commits !== undefined) facts.push({ label: "Commits", value: String(commits) });
  const changedFiles = toFiniteNumber(result.changedFiles);

  if (changedFiles !== undefined) facts.push({ label: "Files", value: String(changedFiles) });
  // PR previews have no comment count or body.
  const comments = toFiniteNumber(result.comments);

  if (comments !== undefined) facts.push({ label: "Comments", value: String(comments) });

  return {
    kind: "entity",
    faviconDomain: INTEGRATIONS.github.domain,
    title: number ? `#${number} ${title}` : title,
    href: toNonEmptyString(result.url),
    badge: githubStateBadge(result),
    facts,
    excerpt: snippetOf(toNonEmptyString(result.body)),
  };
}

const ENTITY_BUILDERS = new Map<ToolName, (result: JsonObject) => EntityView | null>([
  ["github.get_pull_request", githubEntity],
  ["github.get_issue", githubEntity],
  [
    "gmail.read_message",
    (result) => {
      const subject = toNonEmptyString(result.subject);

      // Newer reads put `from`/`to`/`snippet` at the top level; older ones under `metadata`.
      const from =
        toNonEmptyString(result.from) ?? toNonEmptyString(getPath(result, "metadata", "from"));

      const to = toNonEmptyString(result.to) ?? toNonEmptyString(getPath(result, "metadata", "to"));

      if (!subject && !from) return null;
      const facts: EntityFact[] = [];

      if (from) facts.push({ label: "From", value: from });

      if (to) facts.push({ label: "To", value: to });
      const date = ago(result.authoredAt);

      if (date) facts.push({ label: "Date", value: date });
      const snippet = toNonEmptyString(getPath(result, "metadata", "snippet"));

      return {
        kind: "entity",
        faviconDomain: INTEGRATIONS.gmail.domain,
        title: subject ?? "(no subject)",
        // Often null for Gmail reads.
        href: toNonEmptyString(result.url),
        facts,
        excerpt: snippet ?? emailBody(toNonEmptyString(result.content)),
      };
    },
  ],
]);

/** A record list or entity for a read tool. `null` keeps the JSON dump. */
export function presentEvidence(tool: ResolvedToolCall): RecordListView | EntityView | null {
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

  const entityBuilder = ENTITY_BUILDERS.get(registeredName);

  if (entityBuilder) return entityBuilder(result);

  return null;
}
