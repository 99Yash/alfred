import { z } from "zod";

/**
 * Thin Google Drive v3 REST client. Same shape as `gmail.ts` /
 * `calendar.ts` — direct JSON calls, no `googleapis` dependency.
 *
 * Read-only: the granted scope is `drive.readonly` (see
 * `DRIVE_READONLY_SCOPE` in oauth.ts). Surface covers "find a file"
 * (search by Drive query), "what is this file" (metadata), and "read its
 * contents" — `exportFile` for Google-native types (Docs/Sheets/Slides
 * → text) and `downloadFile` for already-textual uploads (alt=media).
 *
 * Callers pass an already-fresh access token — get it from
 * `getFreshAccessToken(credentialId)` first.
 */

const API_BASE = "https://www.googleapis.com/drive/v3/files";

/** Fields we ask Drive to return per file — keeps the payload tight and predictable. */
const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,iconLink,owners(emailAddress)";

const fileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  modifiedTime: z.string().optional(),
  /** Bytes, as a string (Drive returns int64 as a string). Absent for Google-native files. */
  size: z.string().optional(),
  webViewLink: z.string().optional(),
  iconLink: z.string().optional(),
  owners: z.array(z.object({ emailAddress: z.string().optional() })).optional(),
});

export type DriveFile = z.infer<typeof fileSchema>;

const listFilesResponseSchema = z.object({
  files: z.array(fileSchema).optional(),
  nextPageToken: z.string().optional(),
});

export interface ListFilesArgs {
  accessToken: string;
  /**
   * Drive query string, e.g. `name contains 'budget'` or
   * `mimeType = 'application/vnd.google-apps.document'`. Omit to list
   * recent files. See https://developers.google.com/drive/api/guides/search-files.
   */
  q?: string;
  pageSize?: number;
  pageToken?: string;
  /** e.g. `modifiedTime desc` (the default), `name`, `folder`. */
  orderBy?: string;
}

export interface ListFilesResult {
  files: DriveFile[];
  nextPageToken?: string;
}

/** Search/list files the user can see. */
export async function listFiles(args: ListFilesArgs): Promise<ListFilesResult> {
  const url = new URL(API_BASE);
  if (args.q) url.searchParams.set("q", args.q);
  url.searchParams.set("pageSize", String(args.pageSize ?? 25));
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  url.searchParams.set("orderBy", args.orderBy ?? "modifiedTime desc");
  url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
  // Cover shared drives too, not just "My Drive".
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const json = await getJson(url.toString(), args.accessToken);
  const parsed = listFilesResponseSchema.parse(json);
  return { files: parsed.files ?? [], nextPageToken: parsed.nextPageToken };
}

export interface GetFileArgs {
  accessToken: string;
  fileId: string;
}

/** Fetch one file's metadata. */
export async function getFile(args: GetFileArgs): Promise<DriveFile> {
  const url = new URL(`${API_BASE}/${encodeURIComponent(args.fileId)}`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const json = await getJson(url.toString(), args.accessToken);
  return fileSchema.parse(json);
}

/** Hard cap on inlined file contents so a large file can't blow up the caller's context. */
const MAX_CONTENT_BYTES = 200_000;

export interface ExportFileArgs {
  accessToken: string;
  fileId: string;
  /** Export MIME type, e.g. `text/plain`, `text/csv`, `text/markdown`. Defaults to `text/plain`. */
  mimeType?: string;
}

export interface FileContentResult {
  fileId: string;
  mimeType: string;
  text: string;
  /** True when the content was cut off at {@link MAX_CONTENT_BYTES}. */
  truncated: boolean;
}

/**
 * Export a Google-native file (Doc/Sheet/Slide) to a text MIME type.
 * Fails for binary uploads — use {@link downloadFile} for those.
 */
export async function exportFile(args: ExportFileArgs): Promise<FileContentResult> {
  const mimeType = args.mimeType ?? "text/plain";
  const url = new URL(`${API_BASE}/${encodeURIComponent(args.fileId)}/export`);
  url.searchParams.set("mimeType", mimeType);
  const { text, truncated } = await getText(url.toString(), args.accessToken);
  return { fileId: args.fileId, mimeType, text, truncated };
}

export interface DownloadFileArgs {
  accessToken: string;
  fileId: string;
}

/**
 * Download a non-native file's bytes as text (`alt=media`). Meaningful only
 * for textual uploads (.txt, .csv, .json, …); binary files come back as
 * mojibake. Capped at {@link MAX_CONTENT_BYTES}.
 */
export async function downloadFile(args: DownloadFileArgs): Promise<FileContentResult> {
  const url = new URL(`${API_BASE}/${encodeURIComponent(args.fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const { text, truncated, mimeType } = await getText(url.toString(), args.accessToken);
  return { fileId: args.fileId, mimeType: mimeType ?? "application/octet-stream", text, truncated };
}

const DRIVE_FETCH_TIMEOUT_MS = 30_000;

async function getJson(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[drive] ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function getText(
  url: string,
  accessToken: string,
): Promise<{ text: string; truncated: boolean; mimeType?: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[drive] ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  const full = await res.text();
  const truncated = full.length > MAX_CONTENT_BYTES;
  return {
    text: truncated ? full.slice(0, MAX_CONTENT_BYTES) : full,
    truncated,
    mimeType: res.headers.get("content-type") ?? undefined,
  };
}
