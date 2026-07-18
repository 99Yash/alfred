import {
  classifyUpload,
  type ChatAttachmentDescriptor,
  isPassThrough,
  SUPPORTED_FILE_TYPES,
} from "@alfred/contracts";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * Chat attachment upload (ADR-0065). Phase 1 is images only: the composer
 * validates a picked file against the shared ingest policy, then — at send time
 * — posts the bytes to the same-origin API, which relays them to the private
 * bucket. At turn time the server verifies the stored object before recording a
 * ready row. Validation here mirrors the server's `assertUploadAllowed` so the
 * user gets an instant, friendly rejection.
 */

/** MIME types the composer accepts today — the model-readable images. */
export const ACCEPTED_MIME_TYPES = SUPPORTED_FILE_TYPES.filter(isPassThrough);

/** `accept` attribute for the file input. */
export const ACCEPT_ATTR = ACCEPTED_MIME_TYPES.join(",");

const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

/** A descriptor for a file that uploaded successfully — handed to the turn. */
export type UploadedAttachment = ChatAttachmentDescriptor;

/**
 * Validate a picked file against the ingest policy. Returns an error message to
 * show the user, or `null` when the file is accepted. Phase 1 accepts only
 * model-readable images; other types are rejected with a "coming soon" note.
 */
export function validateFile(file: File): string | null {
  const policy = classifyUpload(file.type);
  if (!policy) return `${file.name}: unsupported file type`;
  if (!isPassThrough(file.type)) {
    return `${file.name}: only images are supported right now`;
  }
  if (file.size <= 0) return `${file.name}: file is empty`;
  if (file.size > policy.maxBytes) {
    const mb = Math.round(policy.maxBytes / (1024 * 1024));
    return `${file.name}: too large (limit ${mb} MB)`;
  }
  return null;
}

/**
 * Upload one file's bytes through the server (ADR-0065). Returns the descriptor
 * to attach to the turn, or throws on failure (the caller toasts and drops just
 * that file). `id` is the client-minted attachment id; it must be the same one
 * passed to the turn so the server rebuilds the matching storage key.
 *
 * We post the bytes to our own API (multipart, same-origin/CORS-cleared) rather
 * than PUT/POST direct-to-bucket: Railway's storage provider serves no CORS
 * `Access-Control-Allow-Origin` header, so a browser→bucket upload is blocked.
 * The server relays the bytes to the bucket (see the `/attachments/upload`
 * route). The presigned-`/sign` route stays available for a future
 * CORS-capable provider.
 */
export async function uploadAttachment(opts: {
  threadId: string;
  messageId: string;
  id: string;
  file: File;
}): Promise<UploadedAttachment> {
  const { threadId, messageId, id, file } = opts;
  const form = new FormData();
  form.append("threadId", threadId);
  form.append("messageId", messageId);
  form.append("attachmentId", id);
  form.append("name", file.name);
  form.append("mime", file.type);
  // Append the bytes last so the multipart parser has the metadata fields first.
  form.append("file", file, file.name);

  // No explicit Content-Type — the browser sets the multipart boundary.
  const res = await fetch(`${API_URL}/api/chat/attachments/upload`, {
    method: "POST",
    credentials: "include",
    body: form,
    signal: AbortSignal.timeout(ATTACHMENT_UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`upload failed (${res.status}): ${body}`);
  }

  return { id, name: file.name, mime: file.type, size: file.size, position: 0 };
}
