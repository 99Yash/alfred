/** Google Drive tools. Read-only, though the grant is full `drive` (ADR-0043). */

import {
  driveDownloadFileInput,
  driveExportFileInput,
  driveGetFileInput,
  driveSearchInput,
  GOOGLE_WORKSPACE_MIME_PREFIX,
  normalizeMimeType,
  restPassthroughInput,
} from "@alfred/contracts";
import { surfaceExternalFileArtifact } from "@alfred/assistant/artifacts";
import { runRestPassthrough } from "./passthrough";
import {
  liveTool,
  type RegisteredTool,
  type ToolExecuteContext,
} from "@alfred/assistant/tool-runtime";

/** A Doc, Sheet, or Slide: the only kind `export_file` can read as text. */
function isGoogleNativeMimeType(mimeType: string | undefined): boolean {
  return normalizeMimeType(mimeType).startsWith(GOOGLE_WORKSPACE_MIME_PREFIX);
}

interface RenderedInSidebarResult {
  status: "rendered_in_sidebar";
  artifactId: string;
  fileName: string;
  mimeType?: string;
  message: string;
}

/**
 * After a failed read, open a binary file in the artifact sidebar so the user can view it.
 * Returns null when that does not apply, and the caller rethrows the original error.
 */
async function maybeSurfaceUnreadableDriveFile(
  ctx: ToolExecuteContext,
  args: { credentialId: string; fileId: string },
): Promise<RenderedInSidebarResult | null> {
  // Artifacts are thread-owned, so a non-chat run has no sidebar.
  if (!ctx.threadId) return null;

  // Succeeds only with real access, so a permission 403 stays a 403.
  let file;

  try {
    file = await ctx.integrations.google.drive.getFile(args);
  } catch {
    return null;
  }

  // A native doc is exportable, so its failure is real. Do not mask it.
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
      const credentialId = (await ctx.integrations.google.drive.credential()).id;

      return ctx.integrations.google.drive.listFiles({
        credentialId,
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
      const credentialId = (await ctx.integrations.google.drive.credential()).id;

      return ctx.integrations.google.drive.getFile({ credentialId, fileId: input.fileId });
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
      const credentialId = (await ctx.integrations.google.drive.credential()).id;

      try {
        return await ctx.integrations.google.drive.exportFile({
          credentialId,
          fileId: input.fileId,
          mimeType: input.mimeType,
        });
      } catch (err) {
        const surfaced = await maybeSurfaceUnreadableDriveFile(ctx, {
          credentialId,
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
      const credentialId = (await ctx.integrations.google.drive.credential()).id;

      try {
        return await ctx.integrations.google.drive.downloadFile({
          credentialId,
          fileId: input.fileId,
        });
      } catch (err) {
        const surfaced = await maybeSurfaceUnreadableDriveFile(ctx, {
          credentialId,
          fileId: input.fileId,
        });

        if (surfaced) return surfaced;
        throw err;
      }
    },
  }),
  liveTool({
    integration: "drive",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Google Drive REST call for file STRUCTURE and metadata the curated drive tools don't return — list/search files (GET '/files'), one file's full metadata (GET '/files/{id}' with a `fields` query for owners/parents/permissions/capabilities), the user + storage quota (GET '/about'), shared drives (GET '/drives'), or the change feed (GET '/changes'). To read a file's CONTENT as text, use the curated drive.export_file (Google-native docs) or drive.download_file (uploads) — this raw read is for structure, not content. Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (never a full URL and never the '/drive/v3' prefix), and `query` for parameters (q, fields, pageSize, orderBy, includeItemsFromAllDrives). This is a raw, unvalidated read: a 404 or empty list may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["drive api", "drive metadata", "call drive", "drive request"],
      tags: ["drive", "files", "storage"],
      entities: ["file", "folder", "shared drive", "permission", "storage quota"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: ["drive.search_files", "drive.get_file", "drive.export_file"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const credentialId = (await ctx.integrations.google.drive.credential()).id;

      return runRestPassthrough(ctx.integrations.google.drive.passthrough(credentialId), input);
    },
  }),
];
