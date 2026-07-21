import type { ToolName } from "@alfred/contracts";
import { domainOf } from "~/lib/favicon";
import { formatRelative } from "~/lib/strings";
import { asRecord, asString, parseJsonRecord, type JsonRecord } from "~/lib/json-record";
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
export interface EvidenceRow {
  /** Stable list key (the record's url/id, falling back to its title). */
  key: string;
  /** Primary line — what the record is. */
  title: string;
  /** Opens in a new tab when present; a link-less row is still shown. */
  href?: string;
  /** Muted secondary line — repo, timestamp, path. */
  meta?: string;
  badge?: EvidenceBadge;
}

/** A list of records a read tool returned (github.search, calendar, …). */
export interface RecordListView {
  kind: "record-list";
  /** Integration domain used for each row's favicon. */
  faviconDomain: string;
  /** The query/context that produced the list, when the result echoes it. */
  query?: string;
  rows: EvidenceRow[];
  /** Exact count of records beyond those shown (`totalCount − shown`). */
  remaining?: number;
  /** More records exist but the count is unknown (pagination flag only). */
  hasMore?: boolean;
}

/** One labeled fact in an entity panel. */
export interface EntityFact {
  label: string;
  value: string;
}

/** A single object a read tool returned (a PR, an email, an issue). */
export interface EntityView {
  kind: "entity";
  faviconDomain: string;
  title: string;
  href?: string;
  badge?: EvidenceBadge;
  facts: EntityFact[];
  /** A short peek at the body (email snippet, issue lede). */
  excerpt?: string;
}

export type EvidenceView = BrowsingView | RecordListView | EntityView;

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

const RAILWAY_TONES: Record<string, EvidenceBadge["tone"]> = {
  SUCCESS: "green",
  FAILED: "red",
  CRASHED: "red",
  BUILDING: "amber",
  DEPLOYING: "amber",
  INITIALIZING: "amber",
  QUEUED: "amber",
};

/** Turn a Drive MIME type into a short human kind ("PDF", "Doc", "Folder"). */
function driveKind(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  if (mimeType === "application/vnd.google-apps.folder") return "Folder";
  if (mimeType === "application/vnd.google-apps.document") return "Doc";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "Sheet";
  if (mimeType === "application/vnd.google-apps.presentation") return "Slides";
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
  const collapsed = text.replace(/\s+/g, " ").trim();
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
 * A `record-list` spec: where the records live, and how to turn each one into
 * a display row. Kept declarative so a new read tool is a handful of lines —
 * the row builder reads only the fields it renders and tolerates missing ones.
 */
interface ListSpec {
  arrayKey: string;
  faviconDomain: string;
  /** The query/context line, read from the result echo or the live args. */
  query?: (result: JsonRecord, args: JsonRecord | null) => string | undefined;
  row: (item: JsonRecord) => EvidenceRow | null;
  /** Exact count beyond the shown rows (e.g. `totalCount − shown`). */
  remaining?: (result: JsonRecord, shown: number) => number | undefined;
  /** More exist, count unknown (a bare pagination flag). */
  hasMore?: (result: JsonRecord) => boolean;
}

/** Railway's two deployment reads (`list_*` / `recent_*`) share a row shape. */
const RAILWAY_DEPLOYMENTS: ListSpec = {
  arrayKey: "deployments",
  faviconDomain: "railway.com",
  row: (item) => {
    const status = asString(item.status);
    const url = asString(item.url);
    if (!status && !url) return null;
    return {
      key: asString(item.id) ?? url ?? status ?? "deployment",
      title: url ?? "Deployment",
      meta: joinMeta(asString(item.serviceName), ago(item.createdAt)),
      badge: status
        ? { label: status.toLowerCase(), tone: RAILWAY_TONES[status] ?? "neutral" }
        : undefined,
    };
  },
};

const LIST_SPECS: Partial<Record<ToolName, ListSpec>> = {
  "github.search": {
    arrayKey: "items",
    faviconDomain: "github.com",
    query: (result) => asString(result.query),
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
  "calendar.list_events": {
    arrayKey: "events",
    faviconDomain: "calendar.google.com",
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
  "notion.search": {
    arrayKey: "hits",
    faviconDomain: "notion.so",
    query: (_result, args) => asString(args?.query),
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
  "drive.search_files": {
    arrayKey: "files",
    faviconDomain: "drive.google.com",
    query: (_result, args) => asString(args?.query),
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
  "railway.list_deployments": RAILWAY_DEPLOYMENTS,
  "railway.recent_deployments": RAILWAY_DEPLOYMENTS,
  "railway.list_projects": {
    arrayKey: "projects",
    faviconDomain: "railway.com",
    row: (item) => {
      const name = asString(item.name);
      if (!name) return null;
      const services = Array.isArray(item.services) ? item.services.length : undefined;
      return {
        key: asString(item.id) ?? name,
        title: name,
        meta: services !== undefined ? `${services} service${services === 1 ? "" : "s"}` : undefined,
      };
    },
  },
};

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
    faviconDomain: "github.com",
    title: number ? `#${number} ${title}` : title,
    href: asString(result.url),
    badge: githubStateBadge(result),
    facts,
    excerpt: snippetOf(asString(result.body)),
  };
}

const ENTITY_BUILDERS: Partial<Record<ToolName, (result: JsonRecord) => EntityView | null>> = {
  "github.get_pull_request": githubEntity,
  "github.get_issue": githubEntity,
  "gmail.read_message": (result) => {
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
      faviconDomain: "mail.google.com",
      title: subject ?? "(no subject)",
      // `url` is frequently null for Gmail reads — render as a link-less card.
      href: asString(result.url),
      facts,
      // The nested shape carries a ready snippet; the flat shape only has the
      // raw RFC822 `content`, so peel the header block off for a body peek.
      excerpt: snippet ?? emailBody(asString(result.content)),
    };
  },
};

/**
 * The panel shape for a non-browsing read tool: a list of records or a single
 * entity, or `null` when the tool has no evidence spec (keeps the JSON dump) or
 * its preview parsed to nothing useful. Best-effort throughout — a pruned or
 * odd-shaped preview simply yields fewer rows, never an error.
 */
export function presentEvidence(tool: ToolCallView): RecordListView | EntityView | null {
  const result = parseJsonRecord(tool.resultPreview);
  if (!result) return null;

  const listSpec = LIST_SPECS[tool.toolName as ToolName];
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
    const args = parseJsonRecord(tool.argsPreview);
    return {
      kind: "record-list",
      faviconDomain: listSpec.faviconDomain,
      query: listSpec.query?.(result, args),
      rows,
      remaining: listSpec.remaining?.(result, rows.length),
      hasMore: listSpec.hasMore?.(result) ?? false,
    };
  }

  const entityBuilder = ENTITY_BUILDERS[tool.toolName as ToolName];
  if (entityBuilder) return entityBuilder(result);

  return null;
}
