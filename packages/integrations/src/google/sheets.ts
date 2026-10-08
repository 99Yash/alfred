import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/**
 * Sheets v4 client: create, read, write, append, and raw `batchUpdate`.
 * Callers pass a token from `getFreshAccessToken(credentialId)`.
 */

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** RAW stores verbatim; USER_ENTERED parses formulas and dates as if typed. */
export type ValueInputOption = "RAW" | "USER_ENTERED";

/** `null` is a blank cell. */
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

/** Lands in the Drive root. */
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

export async function getValues(
  args: GetValuesArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GetValuesResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`;
  const parsed = await sendJson(valueRangeSchema, "GET", url, args.accessToken, undefined, retry);

  return {
    range: parsed.range,
    // SAFETY: valueRangeSchema validated unknown[][]; Sheets renders cells as CellValue.
    values: (parsed.values ?? []) as CellValue[][],
  };
}

export interface UpdateValuesArgs {
  accessToken: string;
  spreadsheetId: string;
  /** A1 notation. */
  range: string;
  values: CellValue[][];
  valueInputOption?: ValueInputOption | undefined;
}

export interface UpdateValuesResult {
  updatedRange?: string | undefined;
  updatedCells?: number | undefined;
}

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
  /** A1 notation of the table, e.g. `Sheet1!A1`. */
  range: string;
  values: CellValue[][];
  valueInputOption?: ValueInputOption | undefined;
}

export interface AppendValuesResult {
  updatedRange?: string | undefined;
  updatedCells?: number | undefined;
}

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
  /** Raw Sheets `Request` objects. `unknown[]` because the union is huge. */
  requests: unknown[];
}

export interface BatchUpdateSpreadsheetResult {
  replies: unknown[];
}

export async function batchUpdateSpreadsheet(
  args: BatchUpdateSpreadsheetArgs,
): Promise<BatchUpdateSpreadsheetResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.spreadsheetId)}:batchUpdate`;

  const parsed = await sendJson(batchUpdateResponseSchema, "POST", url, args.accessToken, {
    requests: args.requests,
  });

  return { replies: parsed.replies ?? [] };
}

/** The raw reply carries the new sheetId. */
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

const sendJson = <T>(
  schema: z.ZodType<T>,
  method: "GET" | "POST" | "PUT",
  url: string,
  accessToken: string,
  payload?: unknown,
  retry: RetryPolicy | "none" = "none",
): Promise<T> =>
  googleJson("sheets", method, url, accessToken, payload, retry).then((raw) => schema.parse(raw));
