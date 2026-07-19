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
  DRIVE_SCOPE,
  downloadFile,
  exportFile,
  getFile,
  listFiles,
} from "@alfred/integrations/google";
import { surfaceExternalFileArtifact } from "../artifacts/external-file";
import { resolveGoogleAccessToken } from "./google-credentials";
import { liveTool, type RegisteredTool, type ToolExecuteContext } from "./registry";

/** Resolve an access token for a Drive call — requires the `drive` scope. */
function accessTokenFor(userId: string): Promise<string> {
  return resolveGoogleAccessToken(userId, {
    scopes: [DRIVE_SCOPE],
    noConnection: "drive_connection_required",
    noScope: "drive_scope_required",
  });
}

/** Google-editable file (Doc/Sheet/Slide) — the only kind `export_file` can read as text. */
function isGoogleNativeMimeType(mimeType: string | undefined): boolean {
  return mimeType?.startsWith("application/vnd.google-apps.") ?? false;
}

/** Result the read tools return once a file has been surfaced inline instead of read. */
interface RenderedInSidebarResult {
  status: "rendered_in_sidebar";
  artifactId: string;
  fileName: string;
  mimeType?: string;
  message: string;
}

/**
 * A Drive read (export/download) failed. If the file is a binary the API can
 * never read as text (a real upload, not a Google-editable doc) and the user can
 * still access it, surface it in the artifact sidebar (#287) so they can view /
 * download it themselves — turning a dead-end ("paste it here") into a rendered
 * file. Returns null when surfacing doesn't apply (no chat thread, the file is a
 * Google-native doc whose failure is transient/permission, or the file itself is
 * unreadable/inaccessible), so the caller rethrows the honest original error.
 */
async function maybeSurfaceUnreadableDriveFile(
  ctx: ToolExecuteContext,
  args: { accessToken: string; fileId: string },
): Promise<RenderedInSidebarResult | null> {
  // Artifacts are thread-owned — a non-chat run (briefing, sub-agent) has no
  // sidebar to surface into, so let the original error stand.
  if (!ctx.threadId) return null;

  // Confirm the file exists and the user can reach it (this succeeds only with
  // real access, so a genuine permission 403 on the read stays a 403). Its
  // mimeType tells us whether text extraction was ever possible.
  let file;
  try {
    file = await getFile({ accessToken: args.accessToken, fileId: args.fileId });
  } catch {
    return null;
  }

  // A Google-native doc IS text-exportable; its read failure is transient or a
  // permission edge, not "this file can't be read as text". Don't mask it.
  if (isGoogleNativeMimeType(file.mimeType) || !file.mimeType) return null;

  const fileName = file.name ?? "file";
  const { artifactId } = await surfaceExternalFileArtifact(
    { userId: ctx.userId, threadId: ctx.threadId, runId: ctx.runId },
    {
      source: "drive",
      fileId: args.fileId,
      previewUrl: `https://drive.google.com/file/d/${encodeURIComponent(args.fileId)}/preview`,
      webViewLink: file.webViewLink,
      mimeType: file.mimeType,
      fileName,
      title: fileName,
    },
  );

  return {
    status: "rendered_in_sidebar",
    artifactId,
    fileName,
    mimeType: file.mimeType,
    message: `"${fileName}" is a ${file.mimeType} file, not a Google-editable doc, so it can't be read in as text. I've opened it in the artifact sidebar so you can view and download it directly.`,
  };
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
      try {
        return await exportFile({ accessToken, fileId: input.fileId, mimeType: input.mimeType });
      } catch (err) {
        const surfaced = await maybeSurfaceUnreadableDriveFile(ctx, {
          accessToken,
          fileId: input.fileId,
        });
        if (surfaced) return surfaced;
        throw err;
      }
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
      try {
        return await downloadFile({ accessToken, fileId: input.fileId });
      } catch (err) {
        const surfaced = await maybeSurfaceUnreadableDriveFile(ctx, {
          accessToken,
          fileId: input.fileId,
        });
        if (surfaced) return surfaced;
        throw err;
      }
    },
  }),
];
