/**
 * Tool input schemas, plus result shapes that web or model code depends on.
 * The dispatcher parses with them and the web approval view derives its form
 * from them (`tool-fields.ts`). `system.spawn_sub_agent` stays server-side.
 *
 * Numbers use `z.coerce.number()`: models often send `pull_number: "305"`.
 * The JSON schema the model sees is still `{type:"integer"}`.
 */

import { z } from "zod";
import {
  activateWorkflowInputSchema,
  authorWorkflowInputSchema,
  authorableWorkflowDefinitionSchema,
  workflowCapabilityDisplaySchema,
  workflowRequiredCapabilitySchema,
} from "./agent";
import {
  ARTIFACT_SECTION_MAX_CHARS,
  artifactFormatSchema,
  artifactKindSchema,
  artifactPageSchema,
} from "./artifacts";
import { contextSearchRequestSchema } from "./context-search";
import { githubSearchQueryIssues, sanitizeGithubSearchQuery } from "./github-search";
import { isRecord } from "./guards";
import { mcpCallInput, mcpToolInspectInputSchema, mcpToolSearchInputSchema } from "./mcp";
import { restPassthroughRequestSchema } from "./passthrough";
import { todoSourceSchema } from "./todos";
import {
  GMAIL_SEARCH_DEFAULT_RESULTS,
  GMAIL_SEARCH_MAX_RESULTS,
  GMAIL_SEARCH_QUERY_MAX_CHARS,
  GMAIL_SEARCH_SNIPPET_MAX_CHARS,
} from "./tool-constants";
import { type ToolName } from "./tools";

/** Zod's email check emits lookahead, which OpenAI rejects in tool parameters. */
const MODEL_TOOL_EMAIL_PATTERN =
  /^[A-Za-z0-9_'+-]+(?:\.[A-Za-z0-9_'+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

function modelToolEmail() {
  return z.string().regex(MODEL_TOOL_EMAIL_PATTERN, "Invalid email address");
}

/**
 * Input tolerance runs in two layers before strict validation:
 * 1. Dispatch `normalizeToolInputKeys`: lossless case and `_`/`-` key fixes for all tools.
 * 2. The per-tool preprocess wrappers in this file (aliases, blank fields, JSON-string
 *    arrays, scalar recipients, calendar windows and seconds, Drive bare terms, GitHub URLs).
 * `z.toJSONSchema(schema, { io: "input" })` unwraps them, so the model and the
 * approval view see only the canonical fields.
 */

/** Same canon as dispatch's `normalizeToolInputKeys`: lowercase, no `_` or `-`. */
export const canonicalParamKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

/** Accept `query` for `q` and the reverse: models mix up the two across tools. */
function withQueryAlias<S extends z.ZodType<any>>(canonical: "q" | "query", schema: S) {
  const alias = canonical === "q" ? "query" : "q";

  return z.preprocess((value) => {
    if (isRecord(value) && typeof value[alias] === "string") {
      const rest = { ...value };

      if (!(canonical in rest)) rest[canonical] = rest[alias];
      delete rest[alias];

      return rest;
    }

    return value;
  }, schema);
}

/**
 * Rename curated 1:1 synonyms (`body` to `bodyText`, `limit` to `perPage`). The
 * alias is always removed; if the canonical key is also set, the canonical wins.
 * Matches the alias case-insensitively: dispatch only normalizes toward accepted
 * keys, so `Limit` would get through. Targets must be the object's own keys.
 */
function withKeyAliases<S extends z.ZodObject>(
  aliases: Record<string, keyof S["shape"] & string>,
  schema: S,
) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const [alias, canonical] of Object.entries(aliases)) {
      const key =
        alias in next
          ? alias
          : Object.keys(next).find((k) => canonicalParamKey(k) === canonicalParamKey(alias));

      if (key === undefined) continue;

      if (next === value) next = { ...value };

      // Fold into the canonical field when absent; else the canonical wins.
      if (!(canonical in next)) next[canonical] = next[key];
      delete next[key];
    }

    return next;
  }, schema);
}

/**
 * Treat a blank string as omitted: models send `query: ""` to skip an optional
 * field. Wrapped at the object level, because a field-level preprocess would
 * mark the field required in the JSON schema. Do not use it on a required field.
 */
function blankFieldToOmitted<S extends z.ZodType<any>>(fields: readonly string[], schema: S) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const field of fields) {
      if (typeof next[field] === "string" && next[field].trim() === "") {
        if (next === value) next = { ...value };
        delete next[field];
      }
    }

    return next;
  }, schema);
}

/**
 * Parse JSON-string arrays (`values: "[[\"a\"]]"`) into arrays. Models do this,
 * and a sheets call once failed four times, then claimed success. A string that
 * is not a JSON array is left for strict validation.
 */
export function coerceJsonArrayFields<S extends z.ZodType<any>>(
  fields: readonly string[],
  schema: S,
) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const field of fields) {
      const raw = next[field];

      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();

      if (!trimmed.startsWith("[")) continue;

      try {
        const parsed: unknown = JSON.parse(trimmed);

        if (Array.isArray(parsed)) {
          if (next === value) next = { ...value };
          next[field] = parsed;
        }
      } catch {}
    }

    return next;
  }, schema);
}

/* ── calendar ─────────────────────────────────────────────────────────── */

const CALENDAR_WINDOW_VALUES = ["today", "tomorrow", "next_7_days"] as const;

const calendarListEventsObject = z
  .object({
    timeMin: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Explicit RFC3339 lower bound. Use when the user gave an exact date/time window. A trailing 'Z' or a numeric UTC offset (e.g. +05:30) are both accepted.",
      ),
    timeMax: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Explicit RFC3339 upper bound. Use with timeMin when the user gave an exact date/time window. A trailing 'Z' or a numeric UTC offset (e.g. +05:30) are both accepted.",
      ),
    window: z
      .enum(CALENDAR_WINDOW_VALUES)
      .optional()
      .describe(
        "Relative window in the user's timezone when explicit bounds are omitted. Omit for the next 7 days. Use 'tomorrow' for requests like 'tomorrow morning'.",
      ),
    partOfDay: z
      .enum(["full_day", "morning", "afternoon", "evening"])
      .optional()
      .describe(
        "Optional narrowing for today/tomorrow. Omit for full day. morning=06:00-12:00, afternoon=12:00-17:00, evening=17:00-22:00.",
      ),
    // Cosmetic cap: an out-of-range value falls back to the default.
    maxResults: z.coerce.number().int().min(1).max(50).default(10).catch(10),
  })
  .strict();
// Bounds and `window` can both be set: models over-specify, and rejecting that
// cost a turn. `resolveCalendarListWindow` lets `window` win.

// Models send the right window value under the wrong key (`timeframe`, `range`).
// Rename any key that holds a window value to `window`. Safe, because no other
// field accepts those values. A non-window value fails strict validation.
function promoteWindowSynonym(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const obj = Object.assign({}, value);

  if (obj.window !== undefined) return obj;
  // SAFETY: widening only types the `.includes` receiver.
  const windowValues = CALENDAR_WINDOW_VALUES as readonly string[];

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string" && windowValues.includes(val)) {
      obj.window = val;
      delete obj[key];
      break;
    }
  }

  return obj;
}

// `.shape` is not on the wrapper: read it from `calendarListEventsObject`.
export const calendarListEventsInput = z.preprocess(promoteWindowSynonym, calendarListEventsObject);

/**
 * Pad minute-precision datetimes (`14:00+05:30`) to `:00` seconds. Zod 4.5 made
 * seconds mandatory and models write minutes. The zone is required to match, so
 * this accepts nothing that Zod 4.4 rejected.
 */
const MINUTE_PRECISION_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/;

function padDatetimeSeconds<S extends z.ZodType<any>>(fields: readonly string[], schema: S) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    for (const field of fields) {
      const raw = next[field];

      if (typeof raw !== "string") continue;
      const match = MINUTE_PRECISION_DATETIME_RE.exec(raw);

      if (!match) continue;

      if (next === value) next = { ...value };
      next[field] = `${match[1]}:00${match[2]}`;
    }

    return next;
  }, schema);
}

export const calendarCreateEventInput = padDatetimeSeconds(
  ["start", "end"],
  coerceJsonArrayFields(
    ["attendees"],
    z
      .object({
        calendarId: z
          .string()
          .min(1)
          .max(200)
          .default("primary")
          .describe(
            "Calendar id to create the event in. Use primary unless the user specified another calendar.",
          ),
        summary: z.string().min(1).max(500),
        description: z.string().max(10_000).optional(),
        location: z.string().max(1_000).optional(),
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
        timeZone: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("IANA timezone for the event. Omit when start/end include explicit offsets."),
        attendees: z.array(modelToolEmail()).max(50).optional(),
      })
      .strict()
      .refine((value) => new Date(value.end) > new Date(value.start), {
        message: "end must be after start",
        path: ["end"],
      }),
  ),
);

export type CalendarCreateEventInput = z.infer<typeof calendarCreateEventInput>;

/** True when Google Calendar will notify external attendees. */
export function calendarCreateEventSendsInvitations(
  input: Pick<CalendarCreateEventInput, "attendees">,
): boolean {
  return (input.attendees?.length ?? 0) > 0;
}

/* ── docs ─────────────────────────────────────────────────────────────── */

export const docsGetDocumentInput = z
  .object({
    documentId: z.string().min(1).max(200).describe("The Google Doc's document id."),
  })
  .strict();

/* ── drive ────────────────────────────────────────────────────────────── */

const driveFileId = z.string().min(1).max(200).describe("The Drive file id.");

/**
 * A bare term (`q=resume`) or `*` is not Drive query syntax, and Drive returns 400.
 * Rewrite a bare term to a name or fullText `contains` clause, and drop a lone `*`.
 * A real clause always has an operator, so it is never touched.
 */
const DRIVE_BARE_TERM_RE = /^[\w.-]+$/;

function promoteDriveBareQuery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const q = value.q;

  if (typeof q !== "string") return value;
  const trimmed = q.trim();

  if (trimmed === "*") {
    const next = Object.assign({}, value);
    delete next.q;

    return next;
  }

  if (DRIVE_BARE_TERM_RE.test(trimmed)) {
    // The regex allows no quote or backslash, so interpolation needs no escaping.
    return Object.assign({}, value, {
      q: `name contains '${trimmed}' or fullText contains '${trimmed}'`,
    });
  }

  return value;
}

export const driveSearchInput = withQueryAlias(
  "q",
  blankFieldToOmitted(
    ["q"],
    z.preprocess(
      promoteDriveBareQuery,
      z
        .object({
          q: z
            .string()
            .min(1)
            .max(1000)
            .optional()
            .describe(
              "Drive query, e.g. `name contains 'budget'` or `mimeType = 'application/vnd.google-apps.document'`. Omit to list recent files.",
            ),
          // Cosmetic cap: fall back to the default.
          pageSize: z.coerce.number().int().min(1).max(100).default(25).catch(25),
          pageToken: z.string().optional().describe("Cursor from a previous page's nextPageToken."),
          orderBy: z
            .string()
            .max(100)
            .optional()
            .describe("Sort order, e.g. `modifiedTime desc` (default), `name`."),
        })
        .strict(),
    ),
  ),
);

export const driveGetFileInput = z.object({ fileId: driveFileId }).strict();

/**
 * Text exports only (ADR-0071). A binary export read through `res.text()` carries
 * NUL bytes that poison the stored result (#267).
 */
export const DRIVE_TEXT_EXPORT_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "application/rtf",
  "application/json",
]);

export const driveExportFileInput = z
  .object({
    fileId: driveFileId,
    mimeType: z
      .string()
      .min(1)
      .max(100)
      .optional()
      // Normalize here, so the value sent to Drive is the one the refine checked.
      .transform((m) => (m === undefined ? undefined : m.toLowerCase().trim()))
      .refine((m) => m === undefined || DRIVE_TEXT_EXPORT_MIME_TYPES.has(m), {
        message: `mimeType must be a text export type — one of: ${[...DRIVE_TEXT_EXPORT_MIME_TYPES].join(", ")}. This tool reads a Google file's text into context; producing a downloadable PDF/slides/spreadsheet is a separate capability it does not have.`,
      })
      .describe(
        "Export MIME type for a Google-native file. Text only: `text/plain` (default), `text/csv`, `text/markdown`, `text/html`. Binary types (PDF, PPTX, XLSX) are not supported — this reads files in as text, it does not produce downloadable documents.",
      ),
  })
  .strict();

export const driveDownloadFileInput = z.object({ fileId: driveFileId }).strict();

/* ── github ───────────────────────────────────────────────────────────── */

const githubOwnerRepo = {
  owner: z.string().min(1).max(100).describe("Repository owner (user or org login)."),
  repo: z.string().min(1).max(100).describe("Repository name."),
};

/** `pull` or `issues` both work: issues and PRs share one number space per repo. */
const GITHUB_ITEM_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)/i;

/**
 * Fix the shapes models send to the GitHub fetch tools: a github.com URL, an
 * `owner/repo` slug in `repo`, or a number synonym (`number`, `prNumber`).
 * Each applies only when the canonical field is absent. The synonym list is closed:
 * `endsWith("number")` would fold `comment_number` and fetch the wrong item.
 */
const GITHUB_OWNER_REPO_SLUG_RE = /^([^/\s]+)\/([^/\s]+)$/;

/** Canonical forms (see {@link canonicalParamKey}). Closed on purpose. */
const GITHUB_ITEM_NUMBER_SYNONYMS: ReadonlySet<string> = new Set([
  "number",
  "prnumber",
  "pullrequestnumber",
  "issuenumber",
]);

function withGithubItemUrl<S extends z.ZodObject>(
  numberKey: keyof S["shape"] & ("pull_number" | "issue_number"),
  schema: S,
) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;

    const fork = () => {
      if (next === value) next = { ...value };
    };

    if (typeof next.url === "string") {
      const match = GITHUB_ITEM_URL_RE.exec(next.url);

      if (match) {
        fork();

        if (!("owner" in next)) next.owner = match[1];

        if (!("repo" in next)) next.repo = match[2];

        if (!(numberKey in next)) next[numberKey] = Number(match[3]);
        delete next.url;
      }
    }

    // A real repo name has no slash, so this can only be a slug.
    if (typeof next.repo === "string" && !("owner" in next)) {
      const slug = GITHUB_OWNER_REPO_SLUG_RE.exec(next.repo.trim());

      if (slug) {
        fork();
        next.owner = slug[1];
        next.repo = slug[2];
      }
    }

    if (!(numberKey in next)) {
      for (const key of Object.keys(next)) {
        if (key === "owner" || key === "repo") continue;

        if (!GITHUB_ITEM_NUMBER_SYNONYMS.has(canonicalParamKey(key))) continue;
        fork();
        next[numberKey] = next[key];
        delete next[key];
        break;
      }
    }

    return next;
  }, schema);
}

/** One `*WithinDays` field. N=1 means today in the user's zone. */
function windowDays(event: string) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      `Only items that ${event} in the user's timezone — N=1 means today, 7 means the past week. Prefer a window field over a free-form created:/merged:/closed: qualifier; the two cannot be mixed.`,
    );
}

export const githubSearchInput = withKeyAliases(
  // `limit` to `perPage`. This needs the plain `.strict()` object, so the query
  // sanitizer runs as `.superRefine` on the wrapper below.
  { limit: "perPage" },
  z
    .object({
      type: z
        .enum(["issue", "pr", "both"])
        // No default: the sanitizer must tell an explicit `pr` from unset, so a
        // free-typed `is:issue` resolves to `issue`, not `both`.
        .optional()
        .describe(
          "What to search: `pr` (pull requests, the default when omitted), `issue` (issues only), or `both`. GitHub's search spans issues and PRs; this owns the is:pr/is:issue clause.",
        ),
      author: z
        .string()
        .min(1)
        .max(100)
        // No default: an `@me` default would narrow a repo or org search to the user's
        // own items. The query builder adds `@me` only for an unscoped search.
        .optional()
        .describe(
          "Author login, or `@me` for the connected user. Omit to leave the search author-unscoped — an otherwise-unscoped search defaults to your items, but a repo-/org-scoped search is left unfiltered by author unless you set `@me`.",
        ),
      state: z
        .enum(["open", "closed", "merged", "all"])
        .default("all")
        .describe(
          "State filter. `closed` includes merged PRs; `merged` is merged-only (PRs). Issues are never `merged`.",
        ),
      // `activeWithinDays` covers every event the search can observe, so no field
      // has to explain how windows combine.
      activeWithinDays: windowDays(
        "did anything — was created, merged, or closed — within the last N calendar days",
      ),
      closedWithinDays: windowDays("closed within the last N calendar days"),
      createdWithinDays: windowDays("was created within the last N calendar days"),
      mergedWithinDays: windowDays("merged within the last N calendar days"),
      query: z
        .string()
        .max(256)
        .optional()
        .describe(
          "Extra GitHub search qualifiers appended verbatim, for filters the structured fields don't cover " +
            '(e.g. "repo:owner/name label:bug review:approved"). Prefer the author/state/type/*WithinDays ' +
            "fields for those — any author:/state:/is: you put here is folded into them automatically — and " +
            "do NOT invent qualifiers: GitHub silently ignores unknown ones (there is no merged-by:, " +
            "closed-by:, etc.) and returns an empty result.",
        ),
      perPage: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        // The count is always exact, so a bad perPage (0 for "count only") falls back.
        .catch(30)
        .describe("Max items to return in the list (the total count is always exact)."),
    })
    .strict(),
)
  // Sanitize first, then reject what cannot be fixed (ADR-0071). Runs after the
  // key-alias fold, so it sees canonical keys.
  .superRefine((value, ctx) => {
    const { sanitized } = sanitizeGithubSearchQuery(value);

    for (const message of githubSearchQueryIssues(sanitized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["query"] });
    }
  });

/**
 * `github.search` result. The UI depends on `totalCount` and the item identity
 * fields. Loose for extras like `note`. A preview missing a core field fails
 * closed: no count rather than a wrong count.
 */
export const githubSearchHitSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
    merged: z.boolean(),
    repository: z.string(),
  })
  .catchall(z.unknown());

export type GithubSearchHit = z.infer<typeof githubSearchHitSchema>;

export const githubSearchResultSchema = z
  .object({
    totalCount: z.number(),
    query: z.string().optional(),
    items: z.array(githubSearchHitSchema),
  })
  .catchall(z.unknown());

export type GithubSearchResult = z.infer<typeof githubSearchResultSchema>;

export const githubGetPullRequestInput = withGithubItemUrl(
  "pull_number",
  z
    .object({
      ...githubOwnerRepo,
      // GitHub's own REST name (`/pulls/{pull_number}`), which the model knows.
      pull_number: z.coerce.number().int().min(1).describe("Pull request number."),
    })
    .strict(),
);

/**
 * `github.get_pull_requests` batch cap (#935): one page of search results.
 * Each item uses the single-PR preprocess.
 */
export const GITHUB_PULL_REQUEST_BATCH_MAX = 25;

export const githubGetPullRequestsInput = coerceJsonArrayFields(
  ["items"],
  z
    .object({
      items: z
        .array(githubGetPullRequestInput)
        .min(1)
        .max(GITHUB_PULL_REQUEST_BATCH_MAX)
        .describe("The pull requests to fetch, each as owner + repo + pull_number (or its url)."),
    })
    .strict(),
);

export const githubGetIssueInput = withGithubItemUrl(
  "issue_number",
  z
    .object({
      ...githubOwnerRepo,
      // GitHub's REST name (`/issues/{issue_number}`).
      issue_number: z.coerce.number().int().min(1).describe("Issue number."),
    })
    .strict(),
);

/* ── gmail ────────────────────────────────────────────────────────────── */

export const gmailSearchHitSchema = z
  .object({
    messageId: z.string().min(1),
    threadId: z.string().min(1),
    documentId: z.string().min(1).nullable(),
    from: z.string().nullable(),
    subject: z.string().nullable(),
    snippet: z.string().max(GMAIL_SEARCH_SNIPPET_MAX_CHARS).nullable(),
    authoredAt: z.iso.datetime().nullable(),
    url: z.string().nullable(),
  })
  .strict();

export type GmailSearchHit = z.infer<typeof gmailSearchHitSchema>;

export const gmailSearchResultSchema = z
  .object({
    /** Echoed back: persisted turns drop `argsPreview`, so a reload needs the query here. */
    query: z.string(),
    messages: z.array(gmailSearchHitSchema),
    nextPageToken: z.string().nullable(),
  })
  .strict();

export type GmailSearchResult = z.infer<typeof gmailSearchResultSchema>;

export const gmailSearchInput = withQueryAlias(
  "q",
  z
    .object({
      q: z
        .string()
        .min(1)
        .max(GMAIL_SEARCH_QUERY_MAX_CHARS)
        .describe(
          "Gmail search query. Supports the full Gmail operator set (in:, from:, has:, …). " +
            "For recency, prefer Gmail's relative operators (newer_than:3d, older_than:1w) — Gmail " +
            "resolves them server-side, so they're immune to timezone/date-math mistakes. Use absolute " +
            "after:/before: dates only for a specific range, computed from the grounded date in the system prompt.",
        ),
      maxResults: z.coerce
        .number()
        .int()
        .min(1)
        .max(GMAIL_SEARCH_MAX_RESULTS)
        .default(GMAIL_SEARCH_DEFAULT_RESULTS)
        // Cosmetic cap: fall back to the default.
        .catch(GMAIL_SEARCH_DEFAULT_RESULTS)
        .describe(
          `Cap on results returned to the model (Gmail allows up to 500; we cap at ${GMAIL_SEARCH_MAX_RESULTS}).`,
        ),
      pageToken: z.string().optional().describe("Cursor from a previous page's nextPageToken."),
    })
    .strict(),
);

/**
 * Wrap a bare recipient string (`to: "a@b.com"`) in an array. Runs after
 * `coerceJsonArrayFields`, so a `[`-prefixed string is a bad JSON array and is
 * left to fail. No trim: this fixes shape, not content. Recipients only.
 */
const GMAIL_RECIPIENT_FIELDS = ["to", "cc", "bcc"] as const;

function wrapScalarRecipients(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let next = value;

  for (const field of GMAIL_RECIPIENT_FIELDS) {
    const raw = next[field];

    if (typeof raw !== "string") continue;

    if (raw.trim().startsWith("[")) continue;

    if (next === value) next = { ...value };
    next[field] = [raw];
  }

  return next;
}

export const gmailSendDraftInput = coerceJsonArrayFields(
  GMAIL_RECIPIENT_FIELDS,
  z.preprocess(
    wrapScalarRecipients,
    withKeyAliases(
      { body: "bodyText" },
      z
        .object({
          to: z.array(modelToolEmail()).min(1).max(25),
          cc: z.array(modelToolEmail()).max(25).optional(),
          bcc: z.array(modelToolEmail()).max(25).optional(),
          subject: z
            .string()
            .min(1)
            .max(1000)
            .refine((s) => !/[\r\n]/.test(s), {
              message: "subject must not contain line breaks",
            }),
          bodyText: z.string().min(1).max(50_000),
          /** Shown on the approval card so the user can confirm the thread. */
          threadId: z.string().optional(),
        })
        .strict(),
    ),
  ),
);

export type GmailSendDraftInput = z.infer<typeof gmailSendDraftInput>;

export const gmailReadMessageInput = z
  .object({
    documentId: z
      .string()
      .min(1)
      .optional()
      .describe("Alfred document id for an ingested Gmail message. Prefer this when available."),
    messageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Provider-native Gmail message id — pass the `messageId` returned by gmail.search here. " +
          "Read fetches it live from Gmail when the message isn't ingested, so this works on fresh " +
          "search results; prefer documentId only when you already have an Alfred document id.",
      ),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Deprecated alias for `messageId`, kept so older calls (or replayed transcripts) that pass " +
          "`id` still resolve. Prefer `messageId`.",
      ),
  })
  .strict()
  .refine((value) => Boolean(value.documentId || value.messageId || value.id), {
    message: "documentId or messageId is required",
  })
  // Fold legacy `id` into `messageId`. Omit absent keys: an `undefined` value is
  // not JSON and would throw at the staging boundary.
  .transform((value) => {
    const messageId = value.messageId ?? value.id;

    return {
      ...(value.documentId === undefined ? {} : { documentId: value.documentId }),
      ...(messageId === undefined ? {} : { messageId }),
    };
  });

/* ── sheets ───────────────────────────────────────────────────────────── */

/** `null` is a blank cell. */
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const cellGrid = z
  .array(z.array(cellValue))
  .min(1)
  .describe("Row-major grid of cell values. Each inner array is one row.");

const valueInputOption = z
  .enum(["RAW", "USER_ENTERED"])
  .default("USER_ENTERED")
  .describe(
    "How values are interpreted: RAW stores verbatim; USER_ENTERED parses formulas/dates as if typed in the UI.",
  );

const a1Range = z
  .string()
  .min(1)
  .max(500)
  .describe("A1 notation, e.g. `Sheet1!A1:C10` (or `Sheet1!A1` to anchor an append).");

const spreadsheetId = z.string().min(1).max(200).describe("The target spreadsheet's id.");

export const sheetsCreateInput = z
  .object({
    title: z.string().min(1).max(500).describe("Title for the new spreadsheet."),
  })
  .strict();

export const sheetsGetValuesInput = z
  .object({
    spreadsheetId,
    range: a1Range,
  })
  .strict();

export const sheetsUpdateValuesInput = coerceJsonArrayFields(
  ["values"],
  z
    .object({
      spreadsheetId,
      range: a1Range,
      values: cellGrid,
      valueInputOption,
    })
    .strict(),
);

export const sheetsAppendValuesInput = coerceJsonArrayFields(
  ["values"],
  z
    .object({
      spreadsheetId,
      range: a1Range,
      values: cellGrid,
      valueInputOption,
    })
    .strict(),
);

export const sheetsBatchUpdateInput = coerceJsonArrayFields(
  ["requests"],
  z
    .object({
      spreadsheetId,
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          "Raw Sheets API `Request` objects (addSheet, repeatCell, mergeCells, …) from https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request.",
        ),
    })
    .strict(),
);

export const sheetsAddSheetInput = z
  .object({
    spreadsheetId,
    title: z.string().min(1).max(500).describe("Title for the new tab."),
  })
  .strict();

/* ── slides ───────────────────────────────────────────────────────────── */

const presentationId = z.string().min(1).max(200).describe("The target presentation's id.");

export const slidesCreateInput = z
  .object({
    title: z.string().min(1).max(500).describe("Title for the new presentation."),
  })
  .strict();

export const slidesGetInput = z
  .object({
    presentationId,
  })
  .strict();

export const slidesBatchUpdateInput = coerceJsonArrayFields(
  ["requests"],
  z
    .object({
      presentationId,
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          "Raw Slides API `Request` objects (createSlide, insertText, createShape, …) from https://developers.google.com/slides/api/reference/rest/v1/presentations/request.",
        ),
    })
    .strict(),
);

export const slidesAddSlideInput = z
  .object({
    presentationId,
    layout: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Predefined layout, e.g. `BLANK`, `TITLE_AND_BODY`. Defaults to BLANK."),
  })
  .strict();

/* ── notion ───────────────────────────────────────────────────────────── */

export const notionSearchInput = blankFieldToOmitted(
  ["query"],
  z
    .object({
      query: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Text to search across the workspace's shared pages and databases. Omit to list recently-edited items.",
        ),
      filter: z
        .enum(["page", "database", "all"])
        .default("all")
        .describe("Restrict results to pages, databases, or both."),
      pageSize: z.coerce.number().int().min(1).max(50).default(10).catch(10),
    })
    .strict(),
);

export const notionGetPageInput = z
  .object({
    pageId: z.string().min(1).max(200).describe("The Notion page id (with or without dashes)."),
  })
  .strict();

export const notionCreatePageInput = z
  .object({
    parentPageId: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Id of the parent page the new page is nested under. The integration must be shared with it.",
      ),
    title: z.string().min(1).max(2_000).describe("Title of the new page."),
    content: z
      .string()
      .max(50_000)
      .optional()
      .describe("Optional body text. Each line becomes its own paragraph block."),
  })
  .strict();

export const notionAppendBlocksInput = z
  .object({
    blockId: z.string().min(1).max(200).describe("Id of the page (or block) to append content to."),
    content: z
      .string()
      .min(1)
      .max(50_000)
      .describe("Text to append. Each line becomes its own paragraph block."),
  })
  .strict();

/**
 * The shared REST passthrough request for every REST integration (ADR-0074).
 * Not `.strict()`: a write method should reach the read gate, which explains the rejection.
 */
export const restPassthroughInput = restPassthroughRequestSchema;

/* ── vercel ───────────────────────────────────────────────────────────── */

export const vercelListProjectsInput = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20).catch(20),
  })
  .strict();

export const vercelListDeploymentsInput = z
  .object({
    projectId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional Vercel project id or name to scope deployments to."),
    limit: z.coerce.number().int().min(1).max(20).default(10).catch(10),
  })
  .strict();

export const vercelRedeployInput = z
  .object({
    deploymentId: z.string().min(1).max(200).describe("Id of the existing deployment to redeploy."),
    name: z
      .string()
      .min(1)
      .max(200)
      .describe("Project name the deployment belongs to (Vercel requires it on redeploy)."),
    target: z
      .enum(["production", "preview"])
      .optional()
      .describe("Deployment target. Omit to keep the original deployment's target."),
  })
  .strict();

/* ── system ───────────────────────────────────────────────────────────── */

export const searchToolsInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .describe("Capability to find, such as 'read a calendar event' or an exact tool name."),
    limit: z.coerce.number().int().min(1).max(10).default(5).catch(5),
  })
  .strict();

export const loadToolInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Exact qualified tool name returned by search_tools."),
  })
  .strict();

export const currentTimeInput = z.object({}).strict();

export const authorWorkflowInput = coerceJsonArrayFields(
  ["capabilities", "assumptions", "externalEffects"],
  authorWorkflowInputSchema,
);

export const recoverWorkflowInput = z
  .object({
    workflowId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200),
  })
  .strict();

// The model copies these names from the server's proposal, so the full tool-name
// enum is not repeated here. `activateWorkflowDefinition` still parses strictly.
const copiedWorkflowCapabilitySchema = workflowRequiredCapabilitySchema.extend({
  tool: z.string().min(1).max(200),
});

const copiedWorkflowDefinitionSchema = authorableWorkflowDefinitionSchema.extend({
  allowedTools: z.array(z.string().min(1).max(200)).max(100),
  requiredCapabilities: z.array(copiedWorkflowCapabilitySchema).max(50),
});

const copiedWorkflowCapabilityDisplaySchema = workflowCapabilityDisplaySchema.extend({
  tool: z.string().min(1).max(200),
});

export const activateWorkflowInput = coerceJsonArrayFields(
  ["resolvedAccounts", "resolvedCapabilities"],
  activateWorkflowInputSchema.extend({
    definition: copiedWorkflowDefinitionSchema,
    resolvedCapabilities: z.array(copiedWorkflowCapabilityDisplaySchema).meta({ readOnly: true }),
    authoringProposal: z.unknown().meta({ readOnly: true }),
  }),
);

const scratchKey = z.string().min(1).max(240);

export const readScratchInput = z.object({ key: scratchKey }).strict();

export const writeScratchInput = z
  .object({
    key: scratchKey,
    value: z.unknown(),
  })
  .strict();

export const promoteScratchInput = z
  .object({
    fromKey: scratchKey,
    toKey: scratchKey,
  })
  .strict();

export const readUserContextInput = coerceJsonArrayFields(
  ["include"],
  blankFieldToOmitted(
    ["query"],
    z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Optional short natural-language focus, e.g. the person, project, preference, or relationship the user referenced.",
          ),
        include: z
          .array(
            z.enum([
              "profile",
              "integrations",
              "facts",
              "preferences",
              "entities",
              "relationships",
              "recent_memory",
            ]),
          )
          .max(7)
          .optional()
          .describe(
            "Optional section hints. The result is still bounded and may include adjacent context needed for provenance.",
          ),
        subjectEmail: z
          .string()
          .trim()
          .toLowerCase()
          .regex(MODEL_TOOL_EMAIL_PATTERN, "Invalid email address")
          .max(320)
          .optional()
          .describe("Optional person/contact email to focus on."),
      })
      .strict(),
  ),
);

// Tool `input_schema` needs a top-level `type: "object"`, and a union serializes
// to a typeless `oneOf`. So one object, `mode` as the discriminant, refinements.
export const readChatHistoryInput = z
  .object({
    mode: z
      .enum(["search", "fetch"])
      .describe(
        "`search` runs a keyword lookup across this thread's messages; `fetch` pulls one item by id.",
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Required for `search`: the keyword query. Omit for `fetch`."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("`search` only: max results to return (1-10, default 5)."),
    kind: z
      .enum(["message", "tool_call", "attachment"])
      .optional()
      .describe("Required for `fetch`: which kind of item `id` refers to. Omit for `search`."),
    id: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .optional()
      .describe("Required for `fetch`: the id of the message, tool call, or attachment."),
  })
  .strict()
  .refine((v) => v.mode !== "search" || v.query !== undefined, {
    message: "query is required when mode is 'search'",
    path: ["query"],
  })
  .refine((v) => v.mode !== "fetch" || (v.kind !== undefined && v.id !== undefined), {
    message: "kind and id are required when mode is 'fetch'",
    path: ["kind"],
  });

const rememberSenderEmail = z.string().trim().toLowerCase().max(320);

const rememberSenderLabel = z
  .string()
  .trim()
  .max(200)
  .nullish()
  .describe(
    "Human display label for the sender, if known. A `domain` scope drops it — a class rule names " +
      "no one person — and the result lists `senderLabel` under `droppedInputs`.",
  );

const rememberScope = z
  .enum(["sender", "domain"])
  .optional()
  .describe(
    "How wide the instruction binds. `sender` (default) binds this one address. `domain` binds every " +
      "address at the sender's domain, including ones that never wrote before; pick it when the user " +
      "names a class of senders, not one mailbox. Alfred derives the domain from the address, and " +
      "only a single organization's domain widens: a personal, school, shared-hosting, or " +
      "mail-service host falls back to `sender`.",
  );

const rememberEntryScope = z
  .enum(["sender", "domain"])
  .optional()
  .describe("Overrides the top-level `scope` for this sender.");

export const rememberInput = coerceJsonArrayFields(
  ["senders"],
  z
    .object({
      kind: z
        .literal("sender_suppression")
        .describe("Persist a resolved sender-level standing instruction."),
      senderEmail: rememberSenderEmail
        .optional()
        .describe(
          "Resolved sender email to suppress. If unresolved, omit it so Alfred can ask a clarification instead of persisting an unmatched instruction.",
        ),
      senderLabel: rememberSenderLabel,
      scope: rememberScope,
      senders: z
        .array(
          z
            .object({
              senderEmail: rememberSenderEmail,
              senderLabel: rememberSenderLabel,
              scope: rememberEntryScope,
            })
            .strict(),
        )
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Every resolved sender to suppress when the user names more than one. One call persists one " +
            "instruction per entry; `accountId`, `directive`, `phrasing`, and the top-level `scope` " +
            "apply to all of them, and an entry's own `scope` overrides that default. An entry at " +
            "`domain` scope ignores `directive` and its own `senderLabel`, so several entries at one " +
            "domain can persist ONE instruction — read each entry's result, not the count. Use this " +
            "instead of one call per sender.",
        ),
      accountId: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe(
          "Optional account scope. Null or omitted means suppress this sender across accounts.",
        ),
      directive: z
        .string()
        .trim()
        .max(1_000)
        .refine((s) => !/[\r\n]/.test(s), {
          message: "directive must be single-line",
        })
        .optional()
        .describe(
          "Resolved instruction sentence for a `sender` scope. Omit to use the default open-loop " +
            "suppression wording. A `domain` scope ignores it: Alfred writes the sentence from the " +
            "domain, and the result lists `directive` under `droppedInputs`.",
        ),
      phrasing: z
        .string()
        .trim()
        .max(1_000)
        .refine((s) => !/[\r\n]/.test(s), {
          message: "phrasing must be single-line",
        })
        .optional()
        .describe("Verbatim user phrasing that asked Alfred to remember this."),
    })
    .strict(),
);

/** No arguments. Returns a bounded newest-first page. */
export const listInstructionsInput = z.object({}).strict();

/** Targets one row by `factId`. Marks it `rejected`, so it can be undone. */
export const forgetInstructionInput = z
  .object({
    factId: z
      .string()
      .min(1)
      .max(100)
      .describe("The `factId` of the instruction to remove, from `list_instructions`."),
    reason: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("Short note on why it's being removed (audit only)."),
  })
  .strict();

/**
 * Change the directive or label, not the target: supersedes the row. A domain row
 * takes neither edit and lists the ignored fields in `droppedInputs`.
 */
export const editInstructionInput = z
  .object({
    factId: z
      .string()
      .min(1)
      .max(100)
      .describe("The `factId` of the instruction to reframe, from `list_instructions`."),
    directive: z
      .string()
      .trim()
      .max(1_000)
      .refine((s) => !/[\r\n]/.test(s), {
        message: "directive must be single-line",
      })
      .optional()
      .describe(
        "New resolved instruction sentence. Omit to leave unchanged. A domain-target row ignores " +
          "it and reports it under `droppedInputs`.",
      ),
    senderLabel: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .describe(
        "New human display label for the sender. Omit to leave unchanged. A domain-target row " +
          "ignores it and reports it under `droppedInputs`.",
      ),
  })
  .strict();

export const resolveTodoInput = z
  .object({
    kind: z
      .literal("gmail_sender")
      .describe("Dismiss live todos that came from Gmail threads matching a sender/source."),
    senderEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(320)
      .optional()
      .describe(
        "Resolved sender email. If unresolved, omit it and provide sourceThreadId if known.",
      ),
    sourceThreadId: z
      .string()
      .trim()
      .max(512)
      .optional()
      .describe("Optional Gmail thread id to resolve exactly."),
    accountId: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .describe("Optional account scope. Null or omitted means match across accounts."),
    reason: z
      .string()
      .trim()
      .max(1_000)
      .optional()
      .describe("Short audit reason for why the todo is being dismissed."),
  })
  .strict();

export const webSearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(1_000)
      .describe(
        "A focused natural-language question to look up on the live web. Phrase it as the thing you want to know, not a bag of keywords.",
      ),
  })
  .strict();

export const fetchUrlInput = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      // Shape only. The scheme and host safety checks run in the server handler (ADR-0071).
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: "url must be an http(s) URL.",
      })
      .describe(
        "The exact http(s) URL to read. Use this when you already hold a link (from the user, from read_user_context, or from a prior tool result) and want its page contents — prefer it over web_search, which discovers sources for a question rather than reading a known page.",
      ),
  })
  .strict();

export const corpusSearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(1_000)
      .describe(
        "A focused natural-language question or phrase to find in the user's ingested documents. Phrase it as the information you want, the way it would appear in the document.",
      ),
  })
  .strict();

/**
 * `system.search_context` input (ADR-0101): {@link contextSearchRequestSchema}
 * without `userId` and the server-owned budgets `expand` and `maxSourceCost`.
 */
export const searchContextInput = coerceJsonArrayFields(
  ["objects"],
  contextSearchRequestSchema
    .omit({ userId: true, expand: true, maxSourceCost: true })
    .strict()
    .describe(
      "One read across Alfred's registered evidence sources for a query. Use it to assemble first-pass evidence, then drill into provider-specific tools for actions or exact records.",
    ),
);

export const suggestTodoInput = coerceJsonArrayFields(
  ["sources"],
  z
    .object({
      name: z.string().min(1).max(2_000).describe("Short imperative title for the commitment."),
      description: z
        .string()
        .max(20_000)
        .optional()
        .describe("Optional longer context for the todo."),
      assist: z
        .string()
        .max(20_000)
        .optional()
        .describe(
          "Optional tip on how to approach it. State honestly if you can't act on it (no permission / integration not connected). This is not execution.",
        ),
      sources: z
        .array(todoSourceSchema)
        .max(64)
        .optional()
        .describe(
          "Cross-source provenance: [{ provider, kind, id, url? }]. Include every channel this commitment spans so it dedups across surfaces.",
        ),
    })
    .strict(),
);

/* ── artifacts (ADR-0075) ─────────────────────────────────────────────── */

/** `spreadsheet` has no renderer yet, and the server mints `external_file` (#287). */
const authorableArtifactKindSchema = artifactKindSchema.exclude(["spreadsheet", "external_file"]);

/**
 * The model fills every field, so `{kind:"pages", markdown:""}` failed the
 * no-markdown refine and it shipped a document instead of a deck.
 * Blank strings mean omitted here.
 */
export const createArtifactInput = blankFieldToOmitted(
  ["markdown", "format"],
  z
    .object({
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Short human title for the artifact, shown in the sidebar header and the chat card.",
        ),
      kind: authorableArtifactKindSchema.describe(
        "`document` for long-form prose (markdown), or `pages` for an ordered deck/PDF of full-bleed HTML pages.",
      ),
      format: artifactFormatSchema
        .optional()
        .describe(
          "Required when kind is `pages`: `slides` (16:9 deck) or `pdf` (portrait letter). Omit for `document`.",
        ),
      markdown: z
        .string()
        .max(ARTIFACT_SECTION_MAX_CHARS)
        .optional()
        .describe(
          "Opening section for a `document` (≤~1,800 words). Author the first section here, then continue with append_artifact_section — each section renders in the sidebar as produced. Do NOT attempt the whole document in one call; a long body must be split into sections. Invalid for `pages` (add pages with append_artifact_page).",
        ),
    })
    .strict()
    .refine((v) => (v.kind === "pages" ? v.format !== undefined : v.format === undefined), {
      message:
        "kind 'pages' needs format 'slides' or 'pdf'; kind 'document' takes no format. For a slide deck send {kind:'pages', format:'slides'} with no markdown, then add each slide with append_artifact_page.",
      path: ["format"],
    })
    .refine((v) => !(v.kind === "pages" && v.markdown !== undefined), {
      message:
        "kind 'pages' takes no markdown. Send {kind:'pages', format:'slides'|'pdf'} with markdown omitted or empty, then add each page with append_artifact_page. markdown is only for kind 'document'.",
      path: ["markdown"],
    }),
);

export const appendArtifactPageInput = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .describe("The artifactId returned by create_artifact. Must be a `pages` artifact."),
    title: z
      .string()
      .max(200)
      .describe("Short page/slide title, shown on the thumbnail and chrome."),
    html: z
      .string()
      .max(200_000)
      .describe(
        "Body-level HTML for one page. Do not include <html>, <head>, <body>, <!doctype>, scripts, external links/CDNs, page geometry, body background, or font boilerplate; the renderer wraps it in the Alfred artifact shell. One call appends one page to the end; call again for each subsequent page.",
      ),
  })
  .strict();

export const appendArtifactSectionInput = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .describe("The artifactId returned by create_artifact. Must be a `document` artifact."),
    markdown: z
      .string()
      .min(1)
      .max(ARTIFACT_SECTION_MAX_CHARS)
      .describe(
        "One section of markdown (≤~1,800 words), appended to the end of the document after a blank line. Write your own `##` headings. Split at block boundaries and keep each section self-contained — close every code fence and finish every list/table within the section, because the sidebar re-renders the whole document as each section arrives. Call again for each subsequent section; also use this to add to a document from an earlier turn.",
      ),
  })
  .strict();

export const updateArtifactInput = coerceJsonArrayFields(
  ["pages"],
  // A blank `markdown` beside `pages` means none.
  blankFieldToOmitted(
    ["title", "markdown"],
    z
      .object({
        artifactId: z.string().min(1).describe("The artifactId to revise."),
        title: z.string().min(1).max(200).optional().describe("New title (rename only)."),
        markdown: z
          .string()
          .max(500_000)
          .optional()
          .describe("Full replacement markdown for a `document` artifact."),
        pages: z
          .array(artifactPageSchema)
          .max(100)
          .optional()
          .describe(
            "Full replacement page list for a `pages` artifact. Send every page you want kept — this replaces the whole set. To merely add a page, prefer append_artifact_page.",
          ),
        baseContentHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
          .describe(
            "Required for cross-turn markdown/pages replacement. Copy it exactly from a complete artifact reference. Omit for rename-only edits or content created earlier in this same run.",
          ),
      })
      .strict()
      .refine((v) => v.title !== undefined || v.markdown !== undefined || v.pages !== undefined, {
        message: "provide at least one of title, markdown, or pages",
      })
      .refine((v) => !(v.markdown !== undefined && v.pages !== undefined), {
        message: "markdown and pages are mutually exclusive (a document has one, a deck the other)",
      }),
  ),
);

/** One table for the schema bounds and the prose that quotes them. */
export const ASK_USER_LIMITS = {
  questions: { min: 1, max: 4 },
  /** More than four is too open for a card (#1019). */
  options: { min: 2, max: 4 },
  /**
   * The card caps its textarea here: it re-parses the draft on every keystroke,
   * and a longer paste would swap the card for a raw-JSON editor.
   */
  customAnswer: { max: 4_000 },
} as const;

const askUserOptionSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Short option text, one to five words. The answer carries this exact label."),
    description: z
      .string()
      .trim()
      .max(400)
      .describe("What choosing this option means or implies for the task."),
  })
  .strict();

export const askUserQuestionSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("The complete question, phrased to the user, ending with a question mark."),
    header: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .describe(
        "Very short chip label for the question, at most 24 characters, e.g. 'Recipients'.",
      ),
    options: z
      .array(askUserOptionSchema)
      .min(ASK_USER_LIMITS.options.min)
      .max(ASK_USER_LIMITS.options.max)
      .describe(
        `${ASK_USER_LIMITS.options.min} to ${ASK_USER_LIMITS.options.max} distinct choices, the recommended one first.`,
      ),
    multiSelect: z
      .boolean()
      .default(false)
      .describe("True when the user may pick several options at once."),
  })
  .strict()
  // The label is the option's identity in answers and in the card, so duplicates
  // would toggle together. Reject them here, not in prose.
  .refine((v) => new Set(v.options.map((option) => option.label)).size === v.options.length, {
    message: "options must carry distinct labels",
    path: ["options"],
  });

export type AskUserQuestion = z.infer<typeof askUserQuestionSchema>;

/**
 * Answers in question order. `customAnswer` is not trimmed: the card re-parses
 * its draft on every keystroke, and a trim deleted each typed space.
 */
export const askUserAnswerSchema = z
  .object({
    selectedOptions: z.array(z.string().trim().min(1).max(120)).max(ASK_USER_LIMITS.options.max),
    customAnswer: z.string().max(ASK_USER_LIMITS.customAnswer.max).nullable(),
  })
  .strict();

export type AskUserAnswer = z.infer<typeof askUserAnswerSchema>;

/** The model's fields, unwrapped so each schema below adds its own wrapper and rules. */
const askUserFields = z.object({
  context: z
    .string()
    .trim()
    .max(4_000)
    .optional()
    .describe(
      "Optional short markdown paragraph that frames why you ask, shown above the questions.",
    ),
  questions: z
    .array(askUserQuestionSchema)
    .min(ASK_USER_LIMITS.questions.min)
    .max(ASK_USER_LIMITS.questions.max)
    .describe(
      `${ASK_USER_LIMITS.questions.min} to ${ASK_USER_LIMITS.questions.max} questions the user answers before the turn continues.`,
    ),
});

/** Written by the decision route, never by the model. */
const askUserAnswersField = z
  .array(askUserAnswerSchema)
  .optional()
  .describe("Filled by the user, never by the model. One entry per question, in the same order.");

/**
 * What the model may write (ADR-0099). No `answers` key, so it cannot answer
 * itself: an optional `answers` once read to the model as a field to fill.
 */
export const askUserModelInput = coerceJsonArrayFields(["questions"], askUserFields.strict());

export type AskUserModelInput = z.infer<typeof askUserModelInput>;

/** Shared, so the two schemas below differ only by the pairing rule. */
const askUserAnswerSheet = askUserFields.extend({ answers: askUserAnswersField }).strict();

/**
 * The runtime schema (ADR-0099). Accepts `answers`, which the decision route
 * writes into the decided input. No length rule on purpose: a stray `answers`
 * must reach the dispatcher's question arm, which names the right repair.
 */
export const askUserInput = coerceJsonArrayFields(["questions", "answers"], askUserAnswerSheet);

export type AskUserInput = z.infer<typeof askUserInput>;

/** Adds the pairing rule, so a wrong-length answer list is a 400 the card can show. */
export const askUserDecidedInput = coerceJsonArrayFields(
  ["questions", "answers"],
  askUserAnswerSheet.refine(
    (v) => v.answers === undefined || v.answers.length === v.questions.length,
    {
      message: "answers must carry exactly one entry per question",
      path: ["answers"],
    },
  ),
);

export type AskUserDecidedInput = z.infer<typeof askUserDecidedInput>;

/**
 * The dispatcher sets `dismissed` and `expired` without running the tool.
 * The tool sets `no_answers` when the row was approved with no edit.
 */
export const askUserUnansweredReasonSchema = z.enum(["dismissed", "expired", "no_answers"]);

export type AskUserUnansweredReason = z.infer<typeof askUserUnansweredReasonSchema>;

/** Shared by `execute` and the dispatcher's synthesized results. */
export const askUserResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    questions: z.array(askUserQuestionSchema),
    answers: z.array(askUserAnswerSchema),
  }),
  z.object({
    status: z.literal("unanswered"),
    reason: askUserUnansweredReasonSchema,
    questions: z.array(askUserQuestionSchema),
    message: z.string(),
  }),
]);

export type AskUserResult = z.infer<typeof askUserResultSchema>;

export type AskUserUnansweredResult = Extract<AskUserResult, { status: "unanswered" }>;

/** By `ToolName`, so the web can find a schema without server code. `system.spawn_sub_agent` is absent on purpose. */
export const TOOL_INPUT_SCHEMAS = {
  "calendar.list_events": calendarListEventsInput,
  "calendar.create_event": calendarCreateEventInput,
  "docs.get_document": docsGetDocumentInput,
  "drive.search_files": driveSearchInput,
  "drive.get_file": driveGetFileInput,
  "drive.export_file": driveExportFileInput,
  "drive.download_file": driveDownloadFileInput,
  "github.search": githubSearchInput,
  "github.get_pull_request": githubGetPullRequestInput,
  "github.get_pull_requests": githubGetPullRequestsInput,
  "github.get_issue": githubGetIssueInput,
  "github.request": restPassthroughInput,
  "notion.search": notionSearchInput,
  "notion.get_page": notionGetPageInput,
  "notion.create_page": notionCreatePageInput,
  "notion.append_blocks": notionAppendBlocksInput,
  "notion.request": restPassthroughInput,
  "vercel.list_projects": vercelListProjectsInput,
  "vercel.list_deployments": vercelListDeploymentsInput,
  "vercel.redeploy": vercelRedeployInput,
  "vercel.request": restPassthroughInput,
  "gmail.search": gmailSearchInput,
  "gmail.send_draft": gmailSendDraftInput,
  "gmail.read_message": gmailReadMessageInput,
  "sheets.create_spreadsheet": sheetsCreateInput,
  "sheets.get_values": sheetsGetValuesInput,
  "sheets.update_values": sheetsUpdateValuesInput,
  "sheets.append_values": sheetsAppendValuesInput,
  "sheets.batch_update": sheetsBatchUpdateInput,
  "sheets.add_sheet": sheetsAddSheetInput,
  "slides.create_presentation": slidesCreateInput,
  "slides.get_presentation": slidesGetInput,
  "slides.batch_update": slidesBatchUpdateInput,
  "slides.add_slide": slidesAddSlideInput,
  "system.search_tools": searchToolsInput,
  "system.load_tool": loadToolInput,
  "system.current_time": currentTimeInput,
  "system.author_workflow": authorWorkflowInput,
  "system.recover_workflow": recoverWorkflowInput,
  "system.activate_workflow": activateWorkflowInput,
  "system.read_user_context": readUserContextInput,
  "system.read_chat_history": readChatHistoryInput,
  "system.read_scratch": readScratchInput,
  "system.write_scratch": writeScratchInput,
  "system.promote": promoteScratchInput,
  "system.remember": rememberInput,
  "system.list_instructions": listInstructionsInput,
  "system.forget_instruction": forgetInstructionInput,
  "system.edit_instruction": editInstructionInput,
  "system.resolve_todo": resolveTodoInput,
  "system.suggest_todo": suggestTodoInput,
  "system.web_search": webSearchInput,
  "system.fetch_url": fetchUrlInput,
  "system.corpus_search": corpusSearchInput,
  "system.search_context": searchContextInput,
  "system.create_artifact": createArtifactInput,
  "system.append_artifact_page": appendArtifactPageInput,
  "system.append_artifact_section": appendArtifactSectionInput,
  "system.update_artifact": updateArtifactInput,
  "system.ask_user": askUserInput,
  "mcp.call": mcpCallInput,
  "mcp.list_tools": mcpToolSearchInputSchema,
  "mcp.inspect_tool": mcpToolInspectInputSchema,
} satisfies Partial<Record<ToolName, z.ZodType>>;

/** Result shapes that web or model code depends on. Most results stay free-form JSON. */
export const TOOL_OUTPUT_SCHEMAS = {
  "gmail.search": gmailSearchResultSchema,
  "github.search": githubSearchResultSchema,
} satisfies Partial<Record<ToolName, z.ZodType>>;
