import { z } from "zod";

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
 * `spreadsheets` scope (see `SHEETS_SCOPE` in oauth.ts).
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
  spreadsheetUrl?: string;
  title?: string;
}

/** Create a new spreadsheet (lands in the user's Drive root). */
export async function createSpreadsheet(
  args: CreateSpreadsheetArgs,
): Promise<CreateSpreadsheetResult> {
  const json = await sendJson("POST", API_BASE, args.accessToken, {
    properties: { title: args.title },
  });
  const parsed = createSpreadsheetResponseSchema.parse(json);
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
  range?: string;
  values: CellValue[][];
}

/** Read a range of cell values. */
export async function getValues(args: GetValuesArgs): Promise<GetValuesResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`;
  const json = await sendJson("GET", url, args.accessToken);
  const parsed = valueRangeSchema.parse(json);
  return { range: parsed.range, values: (parsed.values ?? []) as CellValue[][] };
}

export interface UpdateValuesArgs {
  accessToken: string;
  spreadsheetId: string;
  /** A1 notation anchor for the write. */
  range: string;
  values: CellValue[][];
  valueInputOption?: ValueInputOption;
}

export interface UpdateValuesResult {
  updatedRange?: string;
  updatedCells?: number;
}

/** Overwrite the values in a range. */
export async function updateValues(args: UpdateValuesArgs): Promise<UpdateValuesResult> {
  const url = new URL(
    `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`,
  );
  url.searchParams.set("valueInputOption", args.valueInputOption ?? "USER_ENTERED");
  const json = await sendJson("PUT", url.toString(), args.accessToken, {
    range: args.range,
    majorDimension: "ROWS",
    values: args.values,
  });
  const parsed = updateValuesResponseSchema.parse(json);
  return { updatedRange: parsed.updatedRange, updatedCells: parsed.updatedCells };
}

export interface AppendValuesArgs {
  accessToken: string;
  spreadsheetId: string;
  /** A1 notation of the table to append after, e.g. `Sheet1!A1`. */
  range: string;
  values: CellValue[][];
  valueInputOption?: ValueInputOption;
}

export interface AppendValuesResult {
  updatedRange?: string;
  updatedCells?: number;
}

/** Append rows after the last row of a table. */
export async function appendValues(args: AppendValuesArgs): Promise<AppendValuesResult> {
  const url = new URL(
    `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:append`,
  );
  url.searchParams.set("valueInputOption", args.valueInputOption ?? "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const json = await sendJson("POST", url.toString(), args.accessToken, {
    range: args.range,
    majorDimension: "ROWS",
    values: args.values,
  });
  const parsed = appendValuesResponseSchema.parse(json);
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
  const json = await sendJson("POST", url, args.accessToken, { requests: args.requests });
  const parsed = batchUpdateResponseSchema.parse(json);
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

const SHEETS_FETCH_TIMEOUT_MS = 30_000;

async function sendJson(
  method: "GET" | "POST" | "PUT",
  url: string,
  accessToken: string,
  payload?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(SHEETS_FETCH_TIMEOUT_MS),
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload ?? {});
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[sheets] ${method} ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
