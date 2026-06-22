import { classifyUpload, isPassThrough, type IngestPolicyEntry } from "@alfred/contracts";
import type { chatAttachments } from "@alfred/db/schemas";
import { BadRequestError } from "../../middleware/errors";
import { buildAttachmentKey } from "./storage";

/**
 * Shared validation + row construction for chat attachments (ADR-0065). Used by
 * both the signed-URL / turn HTTP endpoints and the Replicache `chatAttachmentCreate`
 * server mutator so all write paths agree on the policy and the storage-key
 * convention — and so the client never gets to choose where its bytes live.
 */

/** A client-supplied attachment descriptor (the bytes are already uploaded). */
export interface AttachmentInput {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * Validate an upload against the ingest policy. Phase 1 accepts only
 * `pass-through` images end to end; audio / pdf / docs / video gain support when
 * the degrade worker lands (Phase 2/3), at which point this gate relaxes.
 * Returns the matched policy entry so the caller can bind its `maxBytes` cap
 * into the signed upload URL (server-side size enforcement at the bucket).
 */
export function assertUploadAllowed(mime: string, size: number): IngestPolicyEntry {
  const policy = classifyUpload(mime);
  if (!policy) {
    throw new BadRequestError(`Unsupported file type: ${mime || "unknown"}`);
  }
  if (!isPassThrough(mime)) {
    throw new BadRequestError(
      "Only image uploads are supported right now — other file types are coming soon.",
    );
  }
  if (size <= 0) throw new BadRequestError("File must not be empty");
  if (size > policy.maxBytes) {
    const mb = Math.round(policy.maxBytes / (1024 * 1024));
    throw new BadRequestError(`File is too large — the limit is ${mb} MB`);
  }
  return policy;
}

/**
 * Build the durable `chat_attachments` insert row for one upload — validating
 * the policy and rebuilding the storage key server-side. Phase 1 images are
 * pass-through, so the row lands `ready` (no degrade). Insert with
 * `onConflictDoNothing` on the id: the turn endpoint and the server mutator both
 * write the same row and the first one wins.
 */
export function toAttachmentRow(opts: {
  userId: string;
  threadId: string;
  messageId: string;
  attachment: AttachmentInput;
}): typeof chatAttachments.$inferInsert {
  const { userId, threadId, messageId, attachment } = opts;
  assertUploadAllowed(attachment.mime, attachment.size);
  return {
    id: attachment.id,
    userId,
    messageId,
    storageKey: buildAttachmentKey({
      userId,
      threadId,
      messageId,
      attachmentId: attachment.id,
      fileName: attachment.name,
    }),
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    status: "ready",
  };
}
