/**
 * Google Drive tools registered into the boss's tool surface.
 *
 * Read-only tool surface (the grant is now full `drive`, but write tools
 * are separate — ADR-0043): find files, read metadata, and pull text
 * contents (export Google-native files, or download textual uploads). All
 * no_risk/low reads — mirrors gmail.ts for credential resolution.
 */

import {
  driveDownloadFileInput,
  driveExportFileInput,
  driveGetFileInput,
  driveSearchInput,
} from "@alfred/contracts";
import {
  downloadFile,
  exportFile,
  getFile,
  getFreshAccessToken,
  listCredentials,
  listFiles,
} from "@alfred/integrations/google";
import { AppError } from "../../lib/app-errors";
import { liveTool, type RegisteredTool } from "./registry";

async function accessTokenFor(userId: string): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new AppError("google_connection_required");
  }
  return getFreshAccessToken(active.id);
}

export const driveTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "drive",
    action: "search_files",
    riskTier: "no_risk",
    description: "Search or list the user's Drive files (with an optional Drive query string).",
    inputSchema: driveSearchInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return listFiles({
        accessToken,
        q: input.q,
        pageSize: input.pageSize,
        pageToken: input.pageToken,
        orderBy: input.orderBy,
      });
    },
  }),
  liveTool({
    integration: "drive",
    action: "get_file",
    riskTier: "no_risk",
    description: "Read one Drive file's metadata (name, mimeType, modified time, link, owners).",
    inputSchema: driveGetFileInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return getFile({ accessToken, fileId: input.fileId });
    },
  }),
  liveTool({
    integration: "drive",
    action: "export_file",
    riskTier: "low",
    description:
      "Read a Google-native file (Doc/Sheet/Slide) in as text so you can reason over its contents. Text export only (text/plain default, text/csv, text/markdown, text/html) — it does NOT produce a downloadable PDF/slides/spreadsheet; that is a separate capability. Use download_file for non-Google uploads. When the user wants a shareable document, a live Google Sheet/Doc link is the deliverable.",
    inputSchema: driveExportFileInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return exportFile({ accessToken, fileId: input.fileId, mimeType: input.mimeType });
    },
  }),
  liveTool({
    integration: "drive",
    action: "download_file",
    riskTier: "low",
    description:
      "Download a non-Google file's contents as text (best for .txt/.csv/.json uploads; binary comes back garbled).",
    inputSchema: driveDownloadFileInput,
    execute: async (input, ctx) => {
      const accessToken = await accessTokenFor(ctx.userId);
      return downloadFile({ accessToken, fileId: input.fileId });
    },
  }),
];
