import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/**
 * Thin Google Sheets v4 REST client. Same shape as `gmail.ts` /
 * `calendar.ts` — we call JSON endpoints directly so we don't pull
 * `googleapis` (~2MB).
 *
 * Surface covers create + edit: make a spreadsheet, read a range, write
 * a range (overwrite), append rows, and an escape-hatch `batchUpdate` for
 * structural edits (add sheet, formatting, etc.) via the raw request
 * objects from https://developers.google.com/sheets/api/reference/rest.
 *
 * Callers pass an already-fresh access token — get it from
 * `getFreshAccessToken(credentialId)` before calling. Requires the
 * `spreadsheets` scope (see `GOOGLE_SCOPE.sheets.full` in `@alfred/contracts`).
 */

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** How user input is interpreted on write: RAW stores verbatim; USER_ENTERED parses formulas/dates as if typed in the UI. */
export type ValueInputOption = "RAW" | "USER_ENTERED";

/** A grid of cell values. Strings, numbers, booleans, or null (blank). */
export type CellValue = string | number | boolean | null;

const createSpreadsheetResponseSchema = z.object({
  spreadsheetId: z.string(),
  spreadsheetUrl: z.string().optional(),
  properties: z.object({ title: z.string().optional() }).optional(),
});

const valueRangeSchema = z.object({
  range: z.string().optional(),
  majorDimension: z.string().optional(),
  values: z.array(z.array(z.unknown())).optional(),
});

const updateValuesResponseSchema = z.object({
  spreadsheetId: z.string().optional(),
  updatedRange: z.string().optional(),
  updatedRows: z.number().optional(),
  updatedColumns: z.number().optional(),
  updatedCells: z.number().optional(),
});

const appendValuesResponseSchema = z.object({
  spreadsheetId: z.string().optional(),
  tableRange: z.string().optional(),
  updates: updateValuesResponseSchema.optional(),
});

const batchUpdateResponseSchema = z.object({
  spreadsheetId: z.string().optional(),
  replies: z.array(z.unknown()).optional(),
});

export interface CreateSpreadsheetArgs {
  accessToken: string;
  title: string;
}

export interface CreateSpreadsheetResult {
  spreadsheetId: string;
  spreadsheetUrl?: string | undefined;
  title?: string | undefined;
}

/** Create a new spreadsheet (lands in the user's Drive root). */
export async function createSpreadsheet(
  args: CreateSpreadsheetArgs,
): Promise<CreateSpreadsheetResult> {
  const parsed = await sendJson(
    createSpreadsheetResponseSchema,
    "POST",
    API_BASE,
    args.accessToken,
    {
      properties: { title: args.title },
    },
  );
  return {
    spreadsheetId: parsed.spreadsheetId,
    spreadsheetUrl: parsed.spreadsheetUrl,
    title: parsed.properties?.title,
  };
}

export interface GetValuesArgs {
  accessToken: string;
  spreadsheetId: string;
  /** A1 notation, e.g. `Sheet1!A1:C10`. */
  range: string;
}

export interface GetValuesResult {
  range?: string | undefined;
  values: CellValue[][];
}

/** Read a range of cell values. */
export async function getValues(
  args: GetValuesArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GetValuesResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`;
  const parsed = await sendJson(valueRangeSchema, "GET", url, args.accessToken, undefined, retry);
  return {
    range: parsed.range,
    // SAFETY: valueRangeSchema validated values as unknown[][]; CellValue is
    // the sheet cell view of that same array-of-arrays (strings, numbers,
    // booleans as Sheets renders them).
    values: (parsed.values ?? []) as CellValue[][],
  };
}

export interface UpdateValuesArgs {
  accessToken: string;
  spreadsheetId: string;
  /** A1 notation anchor for the write. */
  range: string;
  values: CellValue[][];
  valueInputOption?: ValueInputOption | undefined;
}

export interface UpdateValuesResult {
  updatedRange?: string | undefined;
  updatedCells?: number | undefined;
}

/** Overwrite the values in a range. */
export async function updateValues(args: UpdateValuesArgs): Promise<UpdateValuesResult> {
  const url = new URL(
    `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`,
  );
  url.searchParams.set("valueInputOption", args.valueInputOption ?? "USER_ENTERED");
  const parsed = await sendJson(
    updateValuesResponseSchema,
    "PUT",
    url.toString(),
    args.accessToken,
    {
      range: args.range,
      majorDimension: "ROWS",
      values: args.values,
    },
  );
  return { updatedRange: parsed.updatedRange, updatedCells: parsed.updatedCells };
}

export interface AppendValuesArgs {
  accessToken: string;
  spreadsheetId: string;
  /** A1 notation of the table to append after, e.g. `Sheet1!A1`. */
  range: string;
  values: CellValue[][];
  valueInputOption?: ValueInputOption | undefined;
}

export interface AppendValuesResult {
  updatedRange?: string | undefined;
  updatedCells?: number | undefined;
}

/** Append rows after the last row of a table. */
export async function appendValues(args: AppendValuesArgs): Promise<AppendValuesResult> {
  const url = new URL(
    `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:append`,
  );
  url.searchParams.set("valueInputOption", args.valueInputOption ?? "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const parsed = await sendJson(
    appendValuesResponseSchema,
    "POST",
    url.toString(),
    args.accessToken,
    {
      range: args.range,
      majorDimension: "ROWS",
      values: args.values,
    },
  );
  return {
    updatedRange: parsed.updates?.updatedRange,
    updatedCells: parsed.updates?.updatedCells,
  };
}

export interface BatchUpdateSpreadsheetArgs {
  accessToken: string;
  spreadsheetId: string;
  /**
   * Raw Sheets API `Request` objects (addSheet, repeatCell, mergeCells, …).
   * Typed as `unknown[]` deliberately — the request union is huge and
   * callers pass shapes straight from Google's reference.
   */
  requests: unknown[];
}

export interface BatchUpdateSpreadsheetResult {
  replies: unknown[];
}

/** Escape hatch for structural edits (add sheet, formatting, etc.). */
export async function batchUpdateSpreadsheet(
  args: BatchUpdateSpreadsheetArgs,
): Promise<BatchUpdateSpreadsheetResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}:batchUpdate`;
  const parsed = await sendJson(batchUpdateResponseSchema, "POST", url, args.accessToken, {
    requests: args.requests,
  });
  return { replies: parsed.replies ?? [] };
}

/** Convenience: add a new tab. Returns the raw reply (carries the new sheetId). */
export async function addSheet(args: {
  accessToken: string;
  spreadsheetId: string;
  title: string;
}): Promise<BatchUpdateSpreadsheetResult> {
  return batchUpdateSpreadsheet({
    accessToken: args.accessToken,
    spreadsheetId: args.spreadsheetId,
    requests: [{ addSheet: { properties: { title: args.title } } }],
  });
}

/** Send and parse at the seam — a raw response cannot reach a caller. */
const sendJson = <T>(
  schema: z.ZodType<T>,
  method: "GET" | "POST" | "PUT",
  url: string,
  accessToken: string,
  payload?: unknown,
  retry: RetryPolicy | "none" = "none",
): Promise<T> =>
  googleJson("sheets", method, url, accessToken, payload, retry).then((raw) => schema.parse(raw));
