/**
 * Google Drive tools registered into the boss's tool surface.
 *
 * Read-only at the current grant (`drive.readonly`): find files, read
 * metadata, and pull text contents (export Google-native files, or
 * download textual uploads). All no_risk/low reads — mirrors gmail.ts for
 * credential resolution.
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
import { liveTool, type RegisteredTool } from "./registry";

async function accessTokenFor(userId: string): Promise<string> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active");
  if (!active) {
    throw new Error(
      `[drive.tools] user ${userId} has no active google credential — reconnect in settings`,
    );
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
      "Export a Google-native file (Doc/Sheet/Slide) to text. Use download_file for non-Google uploads.",
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
