import {
  collapseWhitespace,
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
import { asRecord, asString, parseJsonRecord, type JsonRecord } from "~/lib/json-record";
import { brandlessToolIcon } from "./animated-tool-icons";
import { toSource, type Source } from "./sources";
import type { ToolCallView } from "./tool-call-presentation";

/**
 * The two system tools that read the live web. Everything about a "browsing"
 * card — the site favicon on the coin, the domain subline, the rich result
 * list instead of a raw JSON dump — is gated on this. `satisfies ToolName`
 * pins each to the canonical contracts key, so a rename there fails to compile
 * here instead of leaving these literals silently wrong.
 */
const WEB_SEARCH_TOOL = "system.web_search" satisfies ToolName;

const FETCH_URL_TOOL = "system.fetch_url" satisfies ToolName;

export interface FetchUrlView {
  kind: "fetch_url";
  /** Bare hostname of the page being read (post-redirect once it lands). */
  domain: string;
  /** The page `<title>`, once the fetch succeeds. */
  title?: string | undefined;
  /** Where the card links: the final URL after redirects, else the requested one. */
  href: string;
  /** A short peek at the sanitized text the fetch pulled back, for the panel. */
  excerpt?: string | undefined;
}

export interface WebSearchView {
  kind: "web_search";
  /** The search query, shown as the card's subline. */
  query?: string | undefined;
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
// Integration evidence — the web-native panel generalized to any read tool.
//
// The two browsing tools above already turn a raw result into favicon rows /
// a page card. Every *other* read tool (gmail.search, github.search, …) falls
// back to a JSON dump. This registry gives the high-traffic reads the same
// treatment: a compact, scannable list of the records they returned, or an
// entity card for the single-object reads — driven from the same persisted
// `resultPreview` the JSON dump uses, so nothing new is exposed and reload
// survives (list results echo their query context; ADR-0070 trim flag still
// applies). A tool with no spec keeps today's JSON fallback untouched.
// ---------------------------------------------------------------------------

/** A status pill next to an evidence row/entity. Tones map to `app-*` scales. */
export interface EvidenceBadge {
  label: string;
  tone: "neutral" | "green" | "red" | "amber" | "purple";
}

/** One record in a `record-list` evidence panel. Renders without an `href`. */
interface EvidenceRow {
  /** Stable list key (the record's url/id, falling back to its title). */
  key: string;
  /** Primary line — what the record is. */
  title: string;
  /** Opens in a new tab when present; a link-less row is still shown. */
  href?: string | undefined;
  /** Muted secondary line — repo, timestamp, path. */
  meta?: string | undefined;
  badge?: EvidenceBadge | undefined;
  /**
   * This row's own glyph, for a list whose records come from several services
   * at once — a corpus search answers with a Gmail message beside a GitHub
   * event, and a tool search answers with one row per integration. Preferred
   * over the list-wide favicon, and preferred over {@link faviconDomain}: the
   * brand renders the service's real logo instead of a fetched favicon.
   */
  brand?: IntegrationBrand | undefined;
  /** This row's own favicon domain, when it has no brand of its own. */
  faviconDomain?: string | undefined;
  /**
   * This row's own glyph, for a record that belongs to no service at all — a
   * tool search answers with `system.current_time` beside `github.search`, and
   * the system half would otherwise sit under an empty chip. Last in the
   * order: a real logo beats a drawn mark.
   */
  icon?: LucideIcon | undefined;
}

/** A list of records a read tool returned (github.search, calendar, …). */
export interface RecordListView {
  kind: "record-list";
  /**
   * Integration domain used for each row's favicon. Absent for a list whose
   * rows each carry their own glyph (a corpus or tool search), where no single
   * service owns the list.
   */
  faviconDomain?: string | undefined;
  /** The query/context that produced the list, when the result echoes it. */
  query?: string | undefined;
  rows: EvidenceRow[];
  /** Exact count of records beyond those shown (`totalCount − shown`). */
  remaining?: number | undefined;
  /** More records exist but the count is unknown (pagination flag only). */
  hasMore?: boolean | undefined;
}

/** One labeled fact in an entity panel. */
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
  /** A short peek at the body (email snippet, issue lede). */
  excerpt?: string | undefined;
}

/** Read a numeric leaf off a best-effort parsed record. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Coarse "3d ago" for a persisted timestamp leaf — reuses the shared clock
 * helper, but only for a real ISO string (a missing/odd leaf yields no meta).
 */
function ago(value: unknown): string | undefined {
  const iso = asString(value);

  return iso ? formatRelative(iso) : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format the *wall-clock* encoded in an offset-bearing ISO string (Google
 * Calendar returns event times in the event's own zone, e.g.
 * `2026-07-13T20:00:00+05:30`). We read the literal Y-M-D h:m out of the string
 * rather than constructing a `Date`, so the panel shows the time the event was
 * scheduled for — not that instant re-expressed in the viewer's timezone.
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

/** A GitHub PR/issue state → its colored pill. */
function githubStateBadge(item: JsonRecord): EvidenceBadge | undefined {
  if (item.draft === true) return { label: "Draft", tone: "neutral" };
  const state = asString(item.state);

  if (state === "open") return { label: "Open", tone: "green" };

  if (item.merged === true) return { label: "Merged", tone: "purple" };

  if (state === "closed") return { label: "Closed", tone: "red" };

  return undefined;
}

/** Turn a Drive MIME type into a short human kind ("PDF", "Doc", "Folder"). */
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

/** Collapse whitespace and cap a free-text blob into a one-glance peek. */
function snippetOf(text: string | undefined, max = 300): string | undefined {
  if (!text) return undefined;
  const collapsed = collapseWhitespace(text);

  return collapsed ? collapsed.slice(0, max) : undefined;
}

/**
 * A short readable peek at an email body. The flat `gmail.read_message` shape
 * stores the raw RFC822 dump (`From: …\nTo: …\n\n<body>`) in `content`, so drop
 * the header block (everything up to the first blank line) and collapse the
 * rest — a snippet-less read still shows what the message says, not its headers.
 */
function emailBody(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const blank = content.indexOf("\n\n");

  return snippetOf(blank >= 0 ? content.slice(blank + 2) : content);
}

/**
 * The read tools whose defining argument is a search intent, so the card may
 * quote it as the row's subline ("Searched GitHub · `repo:99Yash/alfred`").
 * An allowlist rather than a "does it have a `query` field" guess, because
 * other tools carry a `query` that is not a search intent. `satisfies` pins
 * each name to the contracts key.
 */
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
 * What a search tool looked for, for the collapsed row's subline and the
 * panel's header.
 *
 * Reads the live args first and the result echo second, in that order, because
 * the two channels have different lifetimes: `argsPreview` rides the live
 * `chat.tool` event but is dropped when the turn is persisted, so after a
 * reload only a result that echoes its own query can still name it. Every tool
 * in {@link SEARCH_TOOLS} either echoes the query today or shows the subline
 * for the live turn alone — never a wrong query, only a missing one.
 */
export function searchQueryOf(tool: ToolCallView): string | undefined {
  if (!isToolName(tool.toolName) || !SEARCH_TOOLS.has(tool.toolName)) return undefined;
  const args = parseJsonRecord(tool.argsPreview);
  const result = parseJsonRecord(tool.resultPreview);

  // `q` is Gmail's own operator-query parameter name; every other search tool
  // names the field `query`.
  return asString(args?.query) ?? asString(args?.q) ?? asString(result?.query);
}

/** The service logo for a qualified tool name (`github.search` → GitHub). */
function brandOfToolName(name: string | undefined): IntegrationBrand | undefined {
  if (!name) return undefined;
  const slug = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;

  return getIntegrationPage(slug)?.brand;
}

/**
 * The service logo for a corpus hit's source. Exhaustive over `DocumentSource`
 * so a new ingest lane fails the typecheck here rather than quietly drawing a
 * blank chip next to its hits. `gmail_attachment` is a file that travelled on
 * a message, so it wears the Gmail mark like its carrier.
 */
const DOCUMENT_SOURCE_BRANDS = {
  gmail: "gmail",
  gmail_attachment: "gmail",
  github: "github",
  sentry: "sentry",
} satisfies Record<DocumentSource, IntegrationBrand>;

/**
 * Read by plain string, not by a cast: `source` arrives off a best-effort
 * parsed preview, so an unknown lane must read as "no glyph" rather than be
 * asserted into the union.
 */
const DOCUMENT_SOURCE_BRAND_BY_KEY: ReadonlyMap<string, IntegrationBrand> = new Map(
  Object.entries(DOCUMENT_SOURCE_BRANDS),
);

function brandOfDocumentSource(source: string | undefined): IntegrationBrand | undefined {
  return source ? DOCUMENT_SOURCE_BRAND_BY_KEY.get(source) : undefined;
}

/**
 * A `record-list` spec: where the records live, and how to turn each one into
 * a display row. Kept declarative so a new read tool is a handful of lines —
 * the row builder reads only the fields it renders and tolerates missing ones.
 */
interface ListSpec {
  arrayKey: string;
  /**
   * The list-wide favicon. Omitted when the rows each carry their own glyph —
   * a corpus or tool search spans several services, so no one domain is right
   * for the whole list.
   */
  faviconDomain?: string | undefined;
  row: (item: JsonRecord) => EvidenceRow | null;
  /** Exact count beyond the shown rows (e.g. `totalCount − shown`). */
  remaining?: ((result: JsonRecord, shown: number) => number | undefined) | undefined;
  /** More exist, count unknown (a bare pagination flag). */
  hasMore?: ((result: JsonRecord) => boolean) | undefined;
}

const LIST_SPECS = new Map<ToolName, ListSpec>([
  [
    // The corpus answers across every lane Alfred has ingested at once, so the
    // list carries no single service: each hit wears its own source's mark.
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
          // The page number is the one fact the extractor proved and the model
          // is forbidden to invent (ADR-0091), so show it where it was proved.
          meta: joinMeta(page ? `page ${page}` : undefined, ago(item.authoredAt)),
          brand: brandOfDocumentSource(asString(item.source)),
        };
      },
    },
  ],
  [
    // The ladder's own first rung. Its result is the answer to "what can I do
    // about this?", which is worth reading as a list of capabilities — the
    // JSON dump it replaces held the same names behind four keys of scoring.
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
          // A `system.*` candidate belongs to no service, so it wears the same
          // mark its own row in the trail would wear.
          icon: brandlessToolIcon(name),
          // A surfaced tool Alfred cannot actually run is the one fact worth a
          // pill here: it explains a search that "found" something and then
          // did nothing with it.
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
        const total = asNumber(result.totalCount);

        return total && total > shown ? total - shown : undefined;
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
        // Google serializes an absent location as the literal string "null".
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

/** GitHub PR/issue reads share a shape: title + state pill + a few facts. */
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
  // Issues carry a comment count + a body; PRs carry neither in the preview.
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
      // Two shapes are persisted: newer reads put `from`/`to`/`snippet` at the
      // top level; older ones nest them under `metadata`. Read both.
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
        // `url` is frequently null for Gmail reads — render as a link-less card.
        href: asString(result.url),
        facts,
        // The nested shape carries a ready snippet; the flat shape only has the
        // raw RFC822 `content`, so peel the header block off for a body peek.
        excerpt: snippet ?? emailBody(asString(result.content)),
      };
    },
  ],
]);

/**
 * The panel shape for a non-browsing read tool: a list of records or a single
 * entity, or `null` when the tool has no evidence spec (keeps the JSON dump) or
 * its preview parsed to nothing useful. Best-effort throughout — a pruned or
 * odd-shaped preview simply yields fewer rows, never an error.
 */
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
