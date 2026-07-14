/**
 * Tool schemas — the single source of truth for every tool's cross-boundary
 * argument shape, plus any result shape that has become a web/model-visible
 * contract. Defined here (in the web-safe contracts package) rather than next
 * to each server handler so that BOTH consumers can read them:
 *
 *   - the server dispatcher validates a proposed call with `.parse()` and
 *     infers the handler's input type via `z.infer`;
 *   - the web approval surface derives typed form controls from the same
 *     schema (see `tool-fields.ts`), so the editor and read-only display can
 *     never drift from what the server actually accepts.
 *
 * Schemas are pure zod (no server imports), so they bundle cleanly into the
 * web app. The one exception — `system.spawn_sub_agent` — stays server-side
 * because its schema references sub-agent internals; the approval UI falls
 * back to a raw-JSON view for it, which is fine (it's a no_risk system tool).
 *
 * Keys of `TOOL_INPUT_SCHEMAS` / `TOOL_OUTPUT_SCHEMAS` are type-checked
 * against `ToolName`, so they can't drift from the real tool surface.
 *
 * Numeric arguments use `z.coerce.number()`, never a bare `z.number()`. LLMs
 * (Claude included) routinely serialize an integer argument as a string —
 * dispatch traces show the boss emitting `pull_number: "305"` and retrying it
 * verbatim until it gives up. Coercion accepts the stringified form while
 * emitting the *identical* `{type:"integer"}` JSON schema to the model, so the
 * surface the model is told about is unchanged — only the server gets more
 * tolerant. Without it, required numeric ids hard-fail and cosmetic `.catch()`
 * caps silently degrade to their default on a stringified value.
 */

import { z } from "zod";
import { artifactFormatSchema, artifactKindSchema, artifactPageSchema } from "./artifacts";
import { githubSearchQueryIssues, sanitizeGithubSearchQuery } from "./github-search";
import { isRecord } from "./guards";
import { todoSourceSchema } from "./todos";
import {
  GMAIL_SEARCH_DEFAULT_RESULTS,
  GMAIL_SEARCH_MAX_RESULTS,
  GMAIL_SEARCH_QUERY_MAX_CHARS,
  GMAIL_SEARCH_SNIPPET_MAX_CHARS,
} from "./tool-constants";
import { INTEGRATION_SLUGS, type ToolName } from "./tools";

/**
 * Zod's built-in email validator emits negative-lookahead assertions in JSON
 * Schema. OpenAI's Responses API rejects regex lookaround in tool parameters,
 * so model-facing email fields use the same practical address grammar without
 * lookaround. Runtime parsing and the model-visible schema still share this
 * single validator.
 */
const MODEL_TOOL_EMAIL_PATTERN =
  /^[A-Za-z0-9_'+-]+(?:\.[A-Za-z0-9_'+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

function modelToolEmail() {
  return z.string().regex(MODEL_TOOL_EMAIL_PATTERN, "Invalid email address");
}

/**
 * Search tools split on the query field name: `drive`/`gmail` use `q` (the
 * Google API param) while `github`/`notion` use `query`. The boss pattern-
 * matches across tools and routinely sends the off-name spelling — dispatch
 * traces show `gmail.search({ query })` hard-failing on the missing `q`. Fold
 * the alias into the canonical field before validation so either spelling
 * parses. The model-facing JSON schema (and the approval UI, which both read
 * `z.toJSONSchema(schema, { io: "input" })`) still advertise only the canonical
 * field, so nothing about the surface the model is told about changes — only
 * the server gets more tolerant. Applied to the `q`-named tools, which the
 * model is likeliest to call with the more common `query`.
 */
function withQueryAlias<S extends z.ZodTypeAny>(canonical: "q" | "query", schema: S) {
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
 * Rename model-supplied parameter *synonyms* to the canonical field before
 * validation. Generalizes {@link withQueryAlias} for the measured cross-tool
 * fumbles where the model reaches for a natural name the strict schema doesn't
 * accept but whose intent is unambiguous — `gmail.send_draft({ body })` for
 * `bodyText`, `github.search({ limit })` for `perPage`. An alias is a
 * hand-curated synonym that is NOT itself an accepted schema key, so it is
 * always removed: folded into the canonical field when that field is absent, or
 * dropped as redundant when the model set the canonical too (the explicit
 * canonical wins — a rare, pathological both-present call is resolved silently
 * rather than bounced, since bouncing a recognizable fumble is exactly what this
 * pass exists to avoid). Wrapped at the object level like the other
 * boundary-tolerance wrappers, so `z.toJSONSchema(schema, { io: "input" })` — and
 * the approval UI — still advertise only the canonical field; only the server
 * gets more tolerant.
 *
 * This is a high-confidence 1:1 synonym map. Pure casing/underscore variants
 * (`max_results` → `maxResults`) are handled generically at the dispatch
 * boundary by `normalizeToolInputKeys`, which is deliberately more conservative
 * (it leaves an ambiguous both-present pair for strict validation) because its
 * fuzzy canonical match spans every field, not a curated set.
 */
function withKeyAliases<S extends z.ZodTypeAny>(aliases: Record<string, string>, schema: S) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (!(alias in next)) continue;
      if (next === value) next = { ...value };
      // An alias is never itself an accepted key, so always remove it: fold it
      // into the canonical field when that's absent, else drop it as redundant
      // (the explicit canonical wins rather than the call bouncing).
      if (!(canonical in next)) next[canonical] = next[alias];
      delete next[alias];
    }
    return next;
  }, schema);
}

/**
 * Treat an empty/whitespace-only string in the named optional fields as
 * "omitted". LLMs routinely emit `query: ""` for an optional argument they
 * intend to skip; a bare `.min(1).optional()` then hard-fails the empty string
 * with `too_small` instead of taking the optional path — dispatch traces show
 * `notion.search` bouncing on `query: ""`, then succeeding on the omit-retry
 * one step later. Drop the blank field before validation so the optional branch
 * takes over. Wrapped at the object level (like `withQueryAlias`) rather than on
 * the field, so `z.toJSONSchema(schema, { io: "input" })` still reports the
 * field as the optional string it is — a field-level `z.preprocess` would
 * instead mark it `required`, telling the model the wrong contract. Only the
 * server gets more tolerant; the surface the model is told about is unchanged.
 * Use only for genuinely-optional fields — a required search box (gmail `q`,
 * web_search `query`) should still reject the empty string rather than silently
 * search for nothing.
 */
function blankFieldToOmitted<S extends z.ZodTypeAny>(fields: readonly string[], schema: S) {
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
 * Parse a JSON-stringified array in the named fields back into a real array
 * before validation. LLMs — Haiku especially — serialize an array-of-arrays or
 * array-of-objects argument as a JSON *string* (`values: "[[\"a\"],[\"b\"]]"`)
 * instead of the structured array. The field's `z.array(...)` then hard-fails
 * with `invalid_type: expected array, received string`; dispatch trace
 * run_9ff8bcw13vba shows the boss bouncing `sheets.update_values`,
 * `sheets.append_values`, and `sheets.batch_update` four times on this exact
 * mistake, then giving up and falsely telling the user the sheet was populated.
 * Mirrors `z.coerce.number()` (stringified ints) and `blankFieldToOmitted`:
 * wrapped at the object level so `z.toJSONSchema(schema, { io: "input" })` still
 * advertises a plain array — only the server gets more tolerant. A string that
 * doesn't JSON-parse to an array is left untouched, so it still fails strict
 * validation and surfaces the enriched dispatcher error.
 */
export function coerceJsonArrayFields<S extends z.ZodTypeAny>(
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
      } catch {
        // Not valid JSON — leave it for the array schema to reject normally.
      }
    }
    return next;
  }, schema);
}

/* ── calendar ─────────────────────────────────────────────────────────── */

const CALENDAR_WINDOW_VALUES = ["today", "tomorrow", "next_7_days"] as const;

const calendarListEventsObject = z
  .object({
    timeMin: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "Explicit RFC3339 lower bound. Use when the user gave an exact date/time window. A trailing 'Z' or a numeric UTC offset (e.g. +05:30) are both accepted.",
      ),
    timeMax: z
      .string()
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
    // Result-count cap — cosmetic, never affects correctness. An out-of-range
    // value falls back to the default instead of bouncing a validation error
    // back to the model (same cosmetic behavior as github.search maxResults).
    maxResults: z.coerce.number().int().min(1).max(50).default(10).catch(10),
  })
  .strict();
// NOTE: explicit bounds and a relative window are NOT mutually exclusive at the
// schema level. The model routinely over-specifies both — 11/11 observed
// `calendar.list_events` failures were the kitchen-sink shape
// `{ timeMin, timeMax, window, partOfDay, maxResults }`, with the model's own
// hand-computed bounds being sloppy (a noon-to-noon window for "today"). A
// mutual-exclusion refine here just bounced those and burned a boss turn. Both
// fields now validate; `resolveCalendarListWindow` resolves the precedence — a
// present `window` value can only come from a relative request, so it wins over
// the redundant bounds and the server resolves it correctly in the user's
// timezone (see the handler for the full rationale).

// The model reliably emits the right relative *value* ("today") but keeps
// guessing the *key* — `timeframe`, `range`, `time_range`, … — instead of
// `window` (observed across traces run_wdtn451w1zp0 / run_w648c33jvwxo /
// run_bwo3shcjqp84). A fixed synonym allowlist is whack-a-mole, so promote
// value-first: if `window` is unset, any key carrying a real window value gets
// renamed to `window`. This is unambiguous because the window values
// (today/tomorrow/next_7_days) are disjoint from every other field's value
// space — partOfDay is morning/…, the bounds are RFC3339 strings, maxResults is
// a number — so no legitimate field can hold one. A synonym carrying a
// non-window value (e.g. `range:"this month"`) is left to fail strict
// validation, surfacing the enriched "valid parameters: …" dispatcher message.
function promoteWindowSynonym(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const obj = { ...value };
  if (obj.window !== undefined) return obj;
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

// `z.toJSONSchema` unwraps the preprocess and serializes the inner object, so
// the model still sees the clean { timeMin, timeMax, window, partOfDay,
// maxResults } surface — the synonyms are an accepted-input convenience, not
// advertised parameters. `.shape` is not available on the wrapper; read it from
// `calendarListEventsObject` if you need the field map.
export const calendarListEventsInput = z.preprocess(promoteWindowSynonym, calendarListEventsObject);

export const calendarCreateEventInput = coerceJsonArrayFields(
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
);

/* ── docs ─────────────────────────────────────────────────────────────── */

export const docsGetDocumentInput = z
  .object({
    documentId: z.string().min(1).max(200).describe("The Google Doc's document id."),
  })
  .strict();

/* ── drive ────────────────────────────────────────────────────────────── */

const driveFileId = z.string().min(1).max(200).describe("The Drive file id.");

/**
 * The one genuine Drive-DSL fumble class (rare): the model passes a bare search
 * *term* instead of a Drive query clause. `q=resume` and `q=*` are not valid
 * Drive query syntax — Drive returns a 400, wasting a boss turn. A valid clause
 * always carries an operator (`name contains 'x'`, `mimeType = '...'`, a date
 * comparison), so a token of only word chars / `.` / `-` (no operator, quote,
 * space, or `=`) can never be a real query. Rewrite such a bare term into a
 * name-or-fullText contains clause so it executes and finds the file the model
 * was reaching for; drop a lone `*` (Drive rejects it) so the call lists recent
 * files. Only rewrites inputs Drive would reject anyway — a well-formed clause
 * is left untouched. fullText is included deliberately: when the model resorts
 * to a bare term it is uncertain what it's looking for, so matching file bodies
 * as well as names maximizes recall; a confident name-only search already writes
 * `name contains '…'` itself.
 */
const DRIVE_BARE_TERM_RE = /^[\w.-]+$/;
function promoteDriveBareQuery(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const q = value.q;
  if (typeof q !== "string") return value;
  const trimmed = q.trim();
  if (trimmed === "*") {
    const next = { ...value };
    delete next.q;
    return next;
  }
  if (DRIVE_BARE_TERM_RE.test(trimmed)) {
    // The regex admits only word chars / `.` / `-`, so `trimmed` can never carry
    // a quote or backslash — it's safe to interpolate into the single-quoted
    // Drive query value without escaping.
    return { ...value, q: `name contains '${trimmed}' or fullText contains '${trimmed}'` };
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
          // Result-count cap — cosmetic; fall back to the default rather than error.
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
 * The only MIME types `drive.export_file` will export to (ADR-0071 honest
 * read-in). This tool exists to pull a Google-native file's **text** into the
 * agent's context to reason over — never to produce a downloadable binary
 * (PDF/PPTX/XLSX). A binary export streamed through `res.text()` returns
 * mojibake carrying NUL bytes that poison the result persist (#267), so binary
 * MIME types are rejected with a teaching redirect rather than attempted.
 * Single source of truth — the tool's runtime guard reads this same set.
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
      // Normalize at parse so the value forwarded downstream is exactly the one
      // that was validated — otherwise `" Text/Plain "` passes the refine
      // (which lower-cases+trims) but reaches the Drive API raw and fails there.
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

/**
 * A github.com issue/PR URL — `github.com/<owner>/<repo>/(pull|issues)/<n>`.
 * Issues and PRs share one number namespace per repo, so the segment
 * (`pull` vs `issues`) doesn't have to match the tool: the owner/repo/number it
 * yields is correct for both `get_pull_request` and `get_issue`, and GitHub's
 * own API 404s if the number is the wrong kind.
 */
const GITHUB_ITEM_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)/i;

/**
 * `github.get_pull_request` / `get_issue` take `owner` + `repo` + the REST-named
 * number, but the model overwhelmingly holds a *URL* (the single biggest measured
 * fumble — `url` ×11) because `github.search` RETURNS one and the natural next
 * step is "fetch that url". It also reaches for a bare `number`. Neither is in
 * the strict schema, so the fetch dead-ends and burns a turn. Decompose a full
 * github.com URL into owner/repo/<numberKey> and alias `number` → the REST key,
 * folding each only when the canonical field is absent (an explicit owner/repo/
 * number always wins). `z.toJSONSchema` unwraps the preprocess, so the model is
 * still told the clean owner/repo/<numberKey> surface; only the server is
 * tolerant.
 */
function withGithubItemUrl<S extends z.ZodTypeAny>(
  numberKey: "pull_number" | "issue_number",
  schema: S,
) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    let next = value;
    if (typeof next.url === "string") {
      const match = GITHUB_ITEM_URL_RE.exec(next.url);
      if (match) {
        next = { ...next };
        if (!("owner" in next)) next.owner = match[1];
        if (!("repo" in next)) next.repo = match[2];
        if (!(numberKey in next)) next[numberKey] = Number(match[3]);
        delete next.url;
      }
    }
    if ("number" in next && !(numberKey in next)) {
      if (next === value) next = { ...value };
      next[numberKey] = next.number;
      delete next.number;
    }
    return next;
  }, schema);
}

export const githubSearchInput = withKeyAliases(
  // The model invents `limit` for the result cap; the field is `perPage`.
  { limit: "perPage" },
  z
    .object({
      type: z
        .enum(["issue", "pr", "both"])
        // No schema default: the query builder treats an omitted `type` as `pr`
        // (its `?? "pr"`), but keeping it OPTIONAL here lets the sanitizer tell a
        // deliberate `type:'pr'` apart from "unset". A free-typed `is:issue` with
        // an unset type then resolves to `issue` instead of silently widening to
        // `both` (which an applied default would have caused).
        .optional()
        .describe(
          "What to search: `pr` (pull requests, the default when omitted), `issue` (issues only), or `both`. GitHub's search spans issues and PRs; this owns the is:pr/is:issue clause.",
        ),
      author: z
        .string()
        .min(1)
        .max(100)
        // No schema default. An applied `@me` default forces every search to be
        // author-scoped, which silently narrows a repo/org search ("open issues in
        // repo:X") to ones the user authored. The query builder defaults author to
        // `@me` only for an otherwise-unscoped search (a bare "my PRs"); a query
        // that names a repo/org/person is left author-unfiltered unless the model
        // sets this. Set `@me` explicitly to force your own items even in a repo.
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
      closedWithinDays: z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          "Only PRs closed within the last N calendar days in the user's timezone — N=1 means today, 7 means the past week. Prefer this over a free-form closed: qualifier.",
        ),
      createdWithinDays: z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          "Only PRs created within the last N calendar days in the user's timezone (N=1 = today). Prefer this over a free-form created: qualifier.",
        ),
      mergedWithinDays: z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          "Only PRs merged within the last N calendar days in the user's timezone — N=1 means today, 7 means the past week. Use with state:'merged' for 'how many PRs did I merge today/in the past week'. Prefer this over a free-form merged: qualifier.",
        ),
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
        // The count is always exact regardless of list size, so an out-of-range
        // perPage (e.g. the model passing 0 to mean "count only") shouldn't burn a
        // turn on a validation error — fall back to the default instead of throwing.
        .catch(30)
        .describe("Max items to return in the list (the total count is always exact)."),
    })
    .strict()
    // Sanitize-and-merge first (fold colliding author:/state:/is:/date qualifiers
    // into the structured fields), then reject only the residue that has no safe
    // auto-fix: invented qualifiers (the silent zero-count `merged-by:` trap),
    // malformed date values, and contradictory field combinations (ADR-0071).
    .superRefine((value, ctx) => {
      const { sanitized } = sanitizeGithubSearchQuery(value);
      for (const message of githubSearchQueryIssues(sanitized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["query"] });
      }
    }),
);

export const githubGetPullRequestInput = withGithubItemUrl(
  "pull_number",
  z
    .object({
      ...githubOwnerRepo,
      // Named to match GitHub's own REST path param (`/pulls/{pull_number}`) so
      // the model passes the field it already knows.
      pull_number: z.coerce.number().int().min(1).describe("Pull request number."),
    })
    .strict(),
);

export const githubGetIssueInput = withGithubItemUrl(
  "issue_number",
  z
    .object({
      ...githubOwnerRepo,
      // Matches GitHub's REST path param (`/issues/{issue_number}`).
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
    authoredAt: z.string().datetime().nullable(),
    url: z.string().nullable(),
  })
  .strict();
export type GmailSearchHit = z.infer<typeof gmailSearchHitSchema>;

export const gmailSearchResultSchema = z
  .object({
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
        // Result-count cap — cosmetic; fall back to the default rather than error.
        .catch(GMAIL_SEARCH_DEFAULT_RESULTS)
        .describe(
          `Cap on results returned to the model (Gmail allows up to 500; we cap at ${GMAIL_SEARCH_MAX_RESULTS}).`,
        ),
      pageToken: z.string().optional().describe("Cursor from a previous page's nextPageToken."),
    })
    .strict(),
);

export const gmailSendDraftInput = coerceJsonArrayFields(
  ["to", "cc", "bcc"],
  // The model reaches for `body` (the plain-English name); the field is
  // `bodyText`. Fold the synonym before validation.
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
        /**
         * Optional `In-Reply-To` / `References` thread anchor — the dispatcher
         * surfaces this on the approval card so the user can confirm what
         * thread Alfred is replying into.
         */
        threadId: z.string().optional(),
      })
      .strict(),
  ),
);

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
  // Fold the legacy `id` alias into `messageId` so consumers read one field.
  .transform((value) => ({
    documentId: value.documentId,
    messageId: value.messageId ?? value.id,
  }));

/* ── sheets ───────────────────────────────────────────────────────────── */

/** A single cell on write: string, number, boolean, or null (blank). */
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

/* ── railway ──────────────────────────────────────────────────────────── */

export const railwayListProjectsInput = z.object({}).strict();

const railwayCredentialId = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Credential id from railway.list_projects identifying which Railway connection to act through. Omit if only one Railway connection exists; required when several are connected.",
  )
  .optional();

export const railwayListDeploymentsInput = z
  .object({
    credentialId: railwayCredentialId,
    projectId: z.string().min(1).max(200).describe("Railway project id to list deployments for."),
    serviceId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional service id to narrow deployments to a single service."),
    environmentId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional environment id (e.g. production) to narrow deployments."),
    limit: z.coerce.number().int().min(1).max(20).default(5).catch(5),
  })
  .strict();

export const railwayGetLogsInput = z
  .object({
    credentialId: railwayCredentialId,
    deploymentId: z.string().min(1).max(200).describe("Railway deployment id to read logs for."),
    limit: z.coerce.number().int().min(1).max(500).default(100).catch(100),
  })
  .strict();

export const railwayRedeployInput = z
  .object({
    credentialId: railwayCredentialId,
    deploymentId: z
      .string()
      .min(1)
      .max(200)
      .describe("Railway deployment id to redeploy (re-runs the same build/release)."),
    // Display-only context for the human approval card. `redeploy` is the one
    // irreversible Railway action and its approval can fire by email / from the
    // standalone /approvals page with no surrounding chat narration — where the
    // raw deploymentId + credentialId are two opaque cuids the approver can't
    // evaluate. These name what is actually being redeployed (which the boss
    // already resolved from list_projects + list_deployments). They are NOT used
    // by the execute path — only deploymentId + credentialId drive the mutation —
    // so a wrong label can mislead the card but can never redirect the redeploy.
    serviceName: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Human name of the service being redeployed (from list_projects). Shown on the approval card so the user can see what is being redeployed, not just an id.",
      ),
    projectName: z
      .string()
      .min(1)
      .max(200)
      .describe("Human name of the project the service belongs to (from list_projects)."),
    environmentName: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Environment the deployment runs in, e.g. 'production' or 'staging' (from list_projects). Critical safety context on the approval card — include it whenever known.",
      ),
  })
  .strict();

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

export const loadIntegrationInput = z
  .object({
    slug: z.enum(INTEGRATION_SLUGS).refine((slug) => slug !== "system", {
      message: "system is always loaded and cannot be loaded as an integration",
    }),
  })
  .strict();

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

// A model-facing tool `input_schema` MUST be a JSON Schema object with a
// top-level `type: "object"`; Anthropic rejects a top-level union (a
// `discriminatedUnion` serializes to a typeless `oneOf`) with
// `tools.N.custom.input_schema.type: Field required`. So this stays a single
// object with `mode` as the discriminant and the per-mode fields optional,
// enforced by refinements — the same shape as `createArtifactInput`.
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

export const rememberInput = z
  .object({
    kind: z
      .literal("sender_suppression")
      .describe("Persist a resolved sender-level standing instruction."),
    senderEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(320)
      .optional()
      .describe(
        "Resolved sender email to suppress. If unresolved, omit it so Alfred can ask a clarification instead of persisting an unmatched instruction.",
      ),
    senderLabel: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .describe("Human display label for the sender, if known."),
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
      .optional()
      .describe(
        "Resolved instruction sentence. Omit to use the default open-loop suppression wording.",
      ),
    phrasing: z
      .string()
      .trim()
      .max(1_000)
      .optional()
      .describe("Verbatim user phrasing that asked Alfred to remember this."),
  })
  .strict();

/**
 * List the user's active standing instructions so the model can reference a
 * specific one (by `factId`) before changing or removing it, and detect when a
 * request is ambiguous (matches several) or conflicts with an existing one.
 * No arguments — the server returns a bounded newest-first page with
 * `totalActive` / `truncated` metadata.
 */
export const listInstructionsInput = z.object({}).strict();

/**
 * Remove a standing instruction the user explicitly asked to drop. Targets one
 * row by its `factId` (from `list_instructions`) so the model never deletes by
 * a fuzzy guess. Non-destructive: the row is marked `rejected`, not hard
 * deleted — reversible and auditable.
 */
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
 * Reframe an existing standing instruction — update its directive wording
 * and/or display label without changing what it targets. Supersedes the old
 * row with a new one (the old row is kept, linked, and reversible). To retarget
 * a different sender, `forget_instruction` the wrong one and `remember` the
 * right one instead.
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
      .optional()
      .describe("New resolved instruction sentence. Omit to leave unchanged."),
    senderLabel: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .describe("New human display label for the sender. Omit to leave unchanged."),
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
      // Validate the URL shape here so a malformed string bounces back to the
      // model with a clear message rather than failing deep in the fetch. The
      // scheme + host safety checks (ADR-0071 honest read-in) run server-side in
      // the handler, since they need URL parsing the web bundle shouldn't carry.
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: "url must be an http(s) URL.",
      })
      .describe(
        "The exact http(s) URL to read. Use this when you already hold a link (from the user, from read_user_context, or from a prior tool result) and want its page contents — prefer it over web_search, which discovers sources for a question rather than reading a known page.",
      ),
  })
  .strict();

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

/**
 * The kinds the boss can actually author. `spreadsheet` is reserved in the
 * artifact type union but has no authoring tool or renderer in v1, so it is
 * excluded here — derived from {@link artifactKindSchema} so it can't drift
 * from the source enum.
 */
const authorableArtifactKindSchema = artifactKindSchema.exclude(["spreadsheet"]);

export const createArtifactInput = z
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
      .max(500_000)
      .optional()
      .describe(
        "Initial markdown body for a `document`. Author the whole document here in one call — content is not token-streamed. Invalid for `pages` (add pages with append_artifact_page).",
      ),
  })
  .strict()
  .refine((v) => (v.kind === "pages" ? v.format !== undefined : v.format === undefined), {
    message: "format is required for kind 'pages' and must be omitted for 'document'",
    path: ["format"],
  })
  .refine((v) => !(v.kind === "pages" && v.markdown !== undefined), {
    message: "markdown is only valid for kind 'document'; use append_artifact_page for pages",
    path: ["markdown"],
  });

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

export const updateArtifactInput = coerceJsonArrayFields(
  ["pages"],
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
);

/**
 * Every tool whose input shape lives here, keyed by `ToolName`. The dispatcher
 * resolves the schema from the owning module (which re-exports these); this
 * map exists so the web layer can look a schema up by name without importing
 * server code. `system.spawn_sub_agent` is intentionally absent.
 */
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
  "github.get_issue": githubGetIssueInput,
  "notion.search": notionSearchInput,
  "notion.get_page": notionGetPageInput,
  "notion.create_page": notionCreatePageInput,
  "notion.append_blocks": notionAppendBlocksInput,
  "railway.list_projects": railwayListProjectsInput,
  "railway.list_deployments": railwayListDeploymentsInput,
  "railway.get_logs": railwayGetLogsInput,
  "railway.redeploy": railwayRedeployInput,
  "vercel.list_projects": vercelListProjectsInput,
  "vercel.list_deployments": vercelListDeploymentsInput,
  "vercel.redeploy": vercelRedeployInput,
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
  "system.load_integration": loadIntegrationInput,
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
  "system.create_artifact": createArtifactInput,
  "system.append_artifact_page": appendArtifactPageInput,
  "system.update_artifact": updateArtifactInput,
} satisfies Partial<Record<ToolName, z.ZodType>>;

/**
 * Tool result schemas that are intentionally part of the cross-boundary
 * contract. Most tool outputs are still free-form `execute_result` JSON; add
 * entries here when web/model-visible consumers depend on a stable result
 * shape.
 */
export const TOOL_OUTPUT_SCHEMAS = {
  "gmail.search": gmailSearchResultSchema,
} satisfies Partial<Record<ToolName, z.ZodType>>;
