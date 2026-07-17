/**
 * Google Sheets tools registered into the boss's tool surface.
 *
 * `sheets.get_values` is a read path; everything else mutates the user's
 * Drive (create a spreadsheet, overwrite/append a range, structural
 * batchUpdate, add a tab) and so registers at a write-grade risk tier. The
 * dispatcher's gate is `user_action_policies`, not the tier — the tier only
 * drives the staging-card UX (per the registry note / ADR-0034).
 *
 * Each execute resolves the user's active Sheets-scoped google credential via
 * the shared resolver, mints a fresh access token, then calls the thin Sheets
 * client. The `spreadsheets` scope is granted when the user connects the Sheets
 * feature; a connected account lacking it raises an actionable
 * `sheets_scope_required` rather than a raw client `[sheets] 403`.
 */

import {
  sheetsAddSheetInput,
  sheetsAppendValuesInput,
  sheetsBatchUpdateInput,
  sheetsCreateInput,
  sheetsGetValuesInput,
  sheetsUpdateValuesInput,
} from "@alfred/contracts";
import {
  addSheet,
  appendValues,
  batchUpdateSpreadsheet,
  createSpreadsheet,
  getValues,
  SHEETS_SCOPE,
  updateValues,
} from "@alfred/integrations/google";
import { resolveGoogleAccessToken } from "./google-credentials";
import { liveTool, type RegisteredTool } from "./registry";

/** Resolve an access token for a Sheets call — requires the `spreadsheets` scope. */
function accessTokenFor(userId: string): Promise<string> {
  return resolveGoogleAccessToken(userId, {
    scopes: [SHEETS_SCOPE],
    noConnection: "google_connection_required",
    noScope: "sheets_scope_required",
  });
}

export const sheetsTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "sheets",
    action: "create_spreadsheet",
    riskTier: "medium",
    description: "Create a new Google Sheets spreadsheet in the user's Drive.",
    inputSchema: sheetsCreateInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return createSpreadsheet({ accessToken, title: input.title });
    },
  }),
  liveTool({
    integration: "sheets",
    action: "get_values",
    riskTier: "no_risk",
    description: "Read a range of cell values from a spreadsheet (A1 notation).",
    inputSchema: sheetsGetValuesInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return getValues({ accessToken, spreadsheetId: input.spreadsheetId, range: input.range });
    },
  }),
  liveTool({
    integration: "sheets",
    action: "update_values",
    riskTier: "medium",
    description: "Overwrite the values in a range of a spreadsheet (A1 notation).",
    inputSchema: sheetsUpdateValuesInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return updateValues({
        accessToken,
        spreadsheetId: input.spreadsheetId,
        range: input.range,
        values: input.values,
        valueInputOption: input.valueInputOption,
      });
    },
  }),
  liveTool({
    integration: "sheets",
    action: "append_values",
    riskTier: "medium",
    description: "Append rows after the last row of a table in a spreadsheet.",
    inputSchema: sheetsAppendValuesInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return appendValues({
        accessToken,
        spreadsheetId: input.spreadsheetId,
        range: input.range,
        values: input.values,
        valueInputOption: input.valueInputOption,
      });
    },
  }),
  liveTool({
    integration: "sheets",
    action: "batch_update",
    riskTier: "medium",
    description:
      "Apply structural edits to a spreadsheet (add sheet, formatting, merge cells, …) via raw Sheets API request objects.",
    inputSchema: sheetsBatchUpdateInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return batchUpdateSpreadsheet({
        accessToken,
        spreadsheetId: input.spreadsheetId,
        requests: input.requests,
      });
    },
  }),
  liveTool({
    integration: "sheets",
    action: "add_sheet",
    riskTier: "medium",
    description: "Add a new tab (sheet) to a spreadsheet.",
    inputSchema: sheetsAddSheetInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return addSheet({ accessToken, spreadsheetId: input.spreadsheetId, title: input.title });
    },
  }),
];
