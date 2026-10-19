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

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** `null` is a blank cell. */
export type CellValue = z.infer<typeof cellValueSchema>;

const createSpreadsheetResponseSchema = z.object({
  spreadsheetId: z.string(),
  spreadsheetUrl: z.string().optional(),
  properties: z.object({ title: z.string().optional() }).optional(),
});

const valueRangeSchema = z.object({
  range: z.string().optional(),
  majorDimension: z.string().optional(),
  values: z.array(z.array(cellValueSchema)).optional(),
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
  const parsed = await googleJson("sheets", createSpreadsheetResponseSchema, {
    method: "POST",
    url: API_BASE,
    accessToken: args.accessToken,
    payload: { properties: { title: args.title } },
  });

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

  const parsed = await googleJson("sheets", valueRangeSchema, {
    url,
    accessToken: args.accessToken,
    retry,
  });

  return {
    range: parsed.range,
    values: parsed.values ?? [],
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

  const parsed = await googleJson("sheets", updateValuesResponseSchema, {
    method: "PUT",
    url: url.toString(),
    accessToken: args.accessToken,
    payload: {
      range: args.range,
      majorDimension: "ROWS",
      values: args.values,
    },
  });

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

  const parsed = await googleJson("sheets", appendValuesResponseSchema, {
    method: "POST",
    url: url.toString(),
    accessToken: args.accessToken,
    payload: {
      range: args.range,
      majorDimension: "ROWS",
      values: args.values,
    },
  });

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

  const parsed = await googleJson("sheets", batchUpdateResponseSchema, {
    method: "POST",
    url,
    accessToken: args.accessToken,
    payload: { requests: args.requests },
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
