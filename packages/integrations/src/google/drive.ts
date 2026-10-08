import { httpErrorFromResponse } from "@alfred/contracts";
import { z } from "zod";
import { INTEGRATION_FETCH_TIMEOUT_MS } from "../shared/authed-fetch";
import { fetchWithRetry, type RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/**
 * Drive v3 client, read-only: search, metadata, and text contents.
 * Callers pass a token from `getFreshAccessToken(credentialId)`.
 */

const API_BASE = "https://www.googleapis.com/drive/v3/files";

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,iconLink,owners(emailAddress)";

const fileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  modifiedTime: z.string().optional(),
  /** Bytes as a string (Drive sends int64 as a string). Absent for Google-native files. */
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
  /** Drive query, e.g. `name contains 'budget'`. Omit to list recent files. */
  q?: string | undefined;
  pageSize?: number | undefined;
  pageToken?: string | undefined;
  /** Default `modifiedTime desc`. */
  orderBy?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ListFilesResult {
  files: DriveFile[];
  nextPageToken?: string | undefined;
}

export async function listFiles(
  args: ListFilesArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<ListFilesResult> {
  const url = new URL(API_BASE);

  if (args.q) url.searchParams.set("q", args.q);
  url.searchParams.set("pageSize", String(args.pageSize ?? 25));

  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  url.searchParams.set("orderBy", args.orderBy ?? "modifiedTime desc");
  url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
  // Include shared drives.
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const parsed = await getJson(
    listFilesResponseSchema,
    url.toString(),
    args.accessToken,
    retry,
    args.signal,
  );

  return { files: parsed.files ?? [], nextPageToken: parsed.nextPageToken };
}

export interface GetFileArgs {
  accessToken: string;
  fileId: string;
  signal?: AbortSignal | undefined;
}

export async function getFile(
  args: GetFileArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<DriveFile> {
  const url = new URL(`${API_BASE}/${encodeURIComponent(args.fileId)}`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");

  return getJson(fileSchema, url.toString(), args.accessToken, retry, args.signal);
}

/** Cap so a large file cannot flood the caller's context. */
const MAX_CONTENT_BYTES = 200_000;

export interface ExportFileArgs {
  accessToken: string;
  fileId: string;
  /** Default `text/plain`. */
  mimeType?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface FileContentResult {
  fileId: string;
  mimeType: string;
  text: string;
  truncated: boolean;
}

/** Google-native files (Docs, Sheets, Slides) only. Use {@link downloadFile} for uploads. */
export async function exportFile(
  args: ExportFileArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<FileContentResult> {
  const mimeType = args.mimeType ?? "text/plain";
  const url = new URL(`${API_BASE}/${encodeURIComponent(args.fileId)}/export`);
  url.searchParams.set("mimeType", mimeType);
  const { text, truncated } = await getText(url.toString(), args.accessToken, retry, args.signal);

  return { fileId: args.fileId, mimeType, text, truncated };
}

export interface DownloadFileArgs {
  accessToken: string;
  fileId: string;
  signal?: AbortSignal | undefined;
}

/** Textual uploads only (`alt=media`); a binary file comes back as mojibake. */
export async function downloadFile(
  args: DownloadFileArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<FileContentResult> {
  const url = new URL(`${API_BASE}/${encodeURIComponent(args.fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const { text, truncated, mimeType } = await getText(
    url.toString(),
    args.accessToken,
    retry,
    args.signal,
  );

  return { fileId: args.fileId, mimeType: mimeType ?? "application/octet-stream", text, truncated };
}

const getJson = <T>(
  schema: z.ZodType<T>,
  url: string,
  accessToken: string,
  retry: RetryPolicy | "none",
  signal?: AbortSignal | undefined,
): Promise<T> =>
  googleJson("drive", "GET", url, accessToken, undefined, retry, signal).then((raw) =>
    schema.parse(raw),
  );

async function getText(
  url: string,
  accessToken: string,
  retry: RetryPolicy | "none",
  signal?: AbortSignal | undefined,
): Promise<{ text: string; truncated: boolean; mimeType?: string }> {
  const send = () =>
    fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:
        signal === undefined
          ? AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS)
          : AbortSignal.any([AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS), signal]),
    });

  const res = retry === "none" ? await send() : await fetchWithRetry(send, { policy: retry });

  if (!res.ok) {
    throw await httpErrorFromResponse("drive", res, { url });
  }

  const full = await res.text();
  const truncated = full.length > MAX_CONTENT_BYTES;
  const mimeType = res.headers.get("content-type");

  return {
    text: truncated ? full.slice(0, MAX_CONTENT_BYTES) : full,
    truncated,
    ...(mimeType !== null ? { mimeType } : {}),
  };
}
