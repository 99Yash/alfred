/**
 * The Google Sheets append tool. The model reads and edits Sheets through the Google Sheets MCP
 * server (ADR-0126).
 */

import { sheetsAppendValuesInput } from "@alfred/contracts";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";

export const sheetsTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "sheets",
    action: "append_values",
    riskTier: "medium",
    replay: "unsafe",
    description: "Append rows after the last row of a table in a spreadsheet.",
    inputSchema: sheetsAppendValuesInput,
    execute: async (input, ctx) => {
      const credentialId = (await ctx.integrations.google.sheets.credential()).id;

      return ctx.integrations.google.sheets.appendValues({
        credentialId,
        spreadsheetId: input.spreadsheetId,
        range: input.range,
        values: input.values,
        valueInputOption: input.valueInputOption,
      });
    },
  }),
];
