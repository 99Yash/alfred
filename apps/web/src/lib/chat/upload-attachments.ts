import { API_URL } from "~/lib/eden";
import {
  classifyUpload,
  type ChatAttachmentDescriptor,
  isChatUploadAllowed,
  SUPPORTED_FILE_TYPES,
} from "@alfred/contracts";

/** Chat attachment upload (ADR-0065). Validation mirrors the server's `assertUploadAllowed`. */

/** Images and PDFs today. */
const ACCEPTED_MIME_TYPES = SUPPORTED_FILE_TYPES.filter(isChatUploadAllowed);

export const ACCEPT_ATTR = ACCEPTED_MIME_TYPES.join(",");

const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

/** An error message for the user, or `null` when the file is accepted. */
export function validateFile(file: File): string | null {
  const policy = classifyUpload(file.type);

  if (!policy) return `${file.name}: unsupported file type`;

  if (!isChatUploadAllowed(file.type)) {
    return `${file.name}: only images and PDFs are supported right now`;
  }

  if (file.size <= 0) return `${file.name}: file is empty`;

  if (file.size > policy.maxBytes) {
    const mb = Math.round(policy.maxBytes / (1024 * 1024));

    return `${file.name}: too large (limit ${mb} MB)`;
  }

  return null;
}

/**
 * Upload through our API, not direct to the bucket: Railway's storage sends no CORS headers.
 * Pass the same `id` to the turn so the server rebuilds the storage key. Throws on failure.
 */
export async function uploadAttachment(opts: {
  threadId: string;
  messageId: string;
  id: string;
  file: File;
}): Promise<ChatAttachmentDescriptor> {
  const { threadId, messageId, id, file } = opts;
  const form = new FormData();
  form.append("threadId", threadId);
  form.append("messageId", messageId);
  form.append("attachmentId", id);
  form.append("name", file.name);
  form.append("mime", file.type);
  // Bytes last, so the parser reads the metadata first.
  form.append("file", file, file.name);

  // No Content-Type: the browser sets the multipart boundary.
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
