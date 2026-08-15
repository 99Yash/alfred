import type { ChatAttachment, NewChatAttachment } from "@alfred/db/schemas";

import type { AttachmentInput } from "./attachments";

/**
 * The pure half of turn admission: does the attachment set a client just resent
 * describe the SAME turn as the rows already on that message?
 *
 * `startChatTurn` asks this on every resend of a `userMessageId` that already
 * carries rows. A match returns the run that exists; a mismatch is a
 * `ConflictError`. Nothing here touches the database, Redis, or storage — the
 * caller supplies the rows — which is what keeps these predicates testable
 * without a service.
 */

export type AttachmentInsertRow = NewChatAttachment;
export type ExistingAttachmentSummary = Pick<
  ChatAttachment,
  "id" | "name" | "mime" | "size" | "position"
>;
export type RetryAttachmentSource = Pick<
  ChatAttachment,
  "id" | "storageKey" | "name" | "mime" | "size"
>;
/**
 * The turn path's view of a fresh attachment: `AttachmentInput`, but with
 * `position` optional because this path derives it (`?? index`) rather than
 * writing the client's value straight to the row.
 */
export type FreshAttachmentDescriptor = Omit<AttachmentInput, "position"> & { position?: number };

export function freshAttachmentRowsMatchSubset(
  inputs: readonly FreshAttachmentDescriptor[],
  rows: readonly ExistingAttachmentSummary[],
): boolean {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const [index, input] of inputs.entries()) {
    const row = rowsById.get(input.id);
    const position = input.position ?? index;
    if (!row) return false;
    if (
      row.name !== input.name ||
      row.mime !== input.mime ||
      row.size !== input.size ||
      row.position !== position
    ) {
      return false;
    }
  }
  return true;
}

export function attachmentRequestMatchesExistingRows(args: {
  fresh: readonly FreshAttachmentDescriptor[];
  retrySources: readonly RetryAttachmentSource[];
  rows: readonly ExistingAttachmentSummary[];
}): boolean {
  const expectedCount = args.fresh.length + args.retrySources.length;
  if (args.rows.length !== expectedCount) return false;
  if (args.fresh.length > 0 && !freshAttachmentRowsMatchSubset(args.fresh, args.rows)) {
    return false;
  }
  const freshIds = new Set(args.fresh.map((input) => input.id));
  const retryRows = args.rows.filter((row) => !freshIds.has(row.id));
  if (retryRows.length !== args.retrySources.length) return false;
  for (const [index, source] of args.retrySources.entries()) {
    const row = retryRows[index];
    const position = args.fresh.length + index;
    if (!row) return false;
    if (
      row.name !== source.name ||
      row.mime !== source.mime ||
      row.size !== source.size ||
      row.position !== position
    ) {
      return false;
    }
  }
  return true;
}

export function sameInsertedAttachmentRows(
  expected: readonly AttachmentInsertRow[],
  rows: readonly ExistingAttachmentSummary[],
): boolean {
  if (expected.length !== rows.length) return false;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const expectedRow of expected) {
    if (!expectedRow.id) return false;
    const row = rowsById.get(expectedRow.id);
    if (!row) return false;
    if (
      row.name !== expectedRow.name ||
      row.mime !== expectedRow.mime ||
      row.size !== expectedRow.size ||
      row.position !== expectedRow.position
    ) {
      return false;
    }
  }
  return true;
}
