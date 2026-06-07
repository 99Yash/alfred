/**
 * Tool input schemas — the single source of truth for every tool's argument
 * shape. Defined here (in the web-safe contracts package) rather than next to
 * each server handler so that BOTH consumers can read them:
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
 * Keys of `TOOL_INPUT_SCHEMAS` are type-checked against `ToolName`, so they
 * can't drift from the real tool surface.
 */

import { z } from "zod";
import { todoSourceSchema } from "./todos.js";
import { INTEGRATION_SLUGS, type ToolName } from "./tools.js";

/* ── calendar ─────────────────────────────────────────────────────────── */

export const calendarListEventsInput = z
  .object({
    timeMin: z
      .string()
      .datetime()
      .optional()
      .describe("Explicit RFC3339 lower bound. Use when the user gave an exact date/time window."),
    timeMax: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Explicit RFC3339 upper bound. Use with timeMin when the user gave an exact date/time window.",
      ),
    window: z
      .enum(["today", "tomorrow", "next_7_days"])
      .default("next_7_days")
      .describe(
        "Relative window in the user's timezone when explicit bounds are omitted. Use 'tomorrow' for requests like 'tomorrow morning'.",
      ),
    partOfDay: z
      .enum(["full_day", "morning", "afternoon", "evening"])
      .default("full_day")
      .describe(
        "Optional narrowing for today/tomorrow: morning=06:00-12:00, afternoon=12:00-17:00, evening=17:00-22:00.",
      ),
    maxResults: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const calendarCreateEventInput = z
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
    start: z.string().datetime(),
    end: z.string().datetime(),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("IANA timezone for the event. Omit when start/end include explicit offsets."),
    attendees: z.array(z.string().email()).max(50).optional(),
  })
  .strict()
  .refine((value) => new Date(value.end) > new Date(value.start), {
    message: "end must be after start",
    path: ["end"],
  });

/* ── docs ─────────────────────────────────────────────────────────────── */

export const docsGetDocumentInput = z
  .object({
    documentId: z.string().min(1).max(200).describe("The Google Doc's document id."),
  })
  .strict();

/* ── drive ────────────────────────────────────────────────────────────── */

const driveFileId = z.string().min(1).max(200).describe("The Drive file id.");

export const driveSearchInput = z
  .object({
    q: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "Drive query, e.g. `name contains 'budget'` or `mimeType = 'application/vnd.google-apps.document'`. Omit to list recent files.",
      ),
    pageSize: z.number().int().min(1).max(100).default(25),
    pageToken: z.string().optional().describe("Cursor from a previous page's nextPageToken."),
    orderBy: z
      .string()
      .max(100)
      .optional()
      .describe("Sort order, e.g. `modifiedTime desc` (default), `name`."),
  })
  .strict();

export const driveGetFileInput = z.object({ fileId: driveFileId }).strict();

export const driveExportFileInput = z
  .object({
    fileId: driveFileId,
    mimeType: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Export MIME type for a Google-native file: `text/plain` (default), `text/csv`, `text/markdown`, …",
      ),
  })
  .strict();

export const driveDownloadFileInput = z.object({ fileId: driveFileId }).strict();

/* ── github ───────────────────────────────────────────────────────────── */

export const searchPullRequestsInput = z
  .object({
    author: z
      .string()
      .min(1)
      .max(100)
      .default("@me")
      .describe("PR author login, or `@me` (default) for the connected user."),
    state: z
      .enum(["open", "closed", "merged", "all"])
      .default("all")
      .describe("PR state filter. `closed` includes merged PRs; `merged` is merged-only."),
    closedWithinDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only PRs closed within the last N days (e.g. 7 for the past week)."),
    createdWithinDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only PRs created within the last N days."),
    query: z
      .string()
      .max(256)
      .optional()
      .describe('Extra GitHub search qualifiers appended verbatim, e.g. "repo:owner/name label:bug".'),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe("Max PRs to return in the list (the total count is always exact)."),
  })
  .strict();

/* ── gmail ────────────────────────────────────────────────────────────── */

export const gmailSearchInput = z
  .object({
    q: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Gmail search query. Supports the full Gmail operator set (in:, from:, newer_than:, has:, …).",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Cap on results returned to the model (Gmail allows up to 500; we cap at 50)."),
  })
  .strict();

export const gmailSendDraftInput = z
  .object({
    to: z.array(z.string().email()).min(1).max(25),
    cc: z.array(z.string().email()).max(25).optional(),
    bcc: z.array(z.string().email()).max(25).optional(),
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
  .strict();

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
      .describe("Provider-native Gmail message id. Use only when no Alfred document id is known."),
  })
  .strict()
  .refine((value) => Boolean(value.documentId || value.messageId), {
    message: "documentId or messageId is required",
  });

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

export const sheetsUpdateValuesInput = z
  .object({
    spreadsheetId,
    range: a1Range,
    values: cellGrid,
    valueInputOption,
  })
  .strict();

export const sheetsAppendValuesInput = z
  .object({
    spreadsheetId,
    range: a1Range,
    values: cellGrid,
    valueInputOption,
  })
  .strict();

export const sheetsBatchUpdateInput = z
  .object({
    spreadsheetId,
    requests: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .describe(
        "Raw Sheets API `Request` objects (addSheet, repeatCell, mergeCells, …) from https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request.",
      ),
  })
  .strict();

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

export const slidesBatchUpdateInput = z
  .object({
    presentationId,
    requests: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .describe(
        "Raw Slides API `Request` objects (createSlide, insertText, createShape, …) from https://developers.google.com/slides/api/reference/rest/v1/presentations/request.",
      ),
  })
  .strict();

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

export const suggestTodoInput = z
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
  .strict();

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
  "github.search_pull_requests": searchPullRequestsInput,
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
  "system.read_scratch": readScratchInput,
  "system.write_scratch": writeScratchInput,
  "system.promote": promoteScratchInput,
  "system.suggest_todo": suggestTodoInput,
} satisfies Partial<Record<ToolName, z.ZodType>>;
