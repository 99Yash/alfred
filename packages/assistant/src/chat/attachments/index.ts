// Internal barrel for `chat` attachment storage. The chat HTTP routes,
// turn admission, compaction, and history retrieval all live in `chat`;
// this folder holds the attachment storage, enrichment, and storage-coordination
// helpers those consume. It is an internal-only barrel — nothing outside
// `chat` imports it, and it imports nothing from its siblings, so it
// stays a leaf inside the module.
export {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
  assertStoredAttachmentBytesMatch,
  assertStoredAttachmentReady,
  assertUploadAllowed,
  sniffPassThroughImageMime,
  toAttachmentRow,
  type AttachmentInput,
} from "./attachments";
export {
  attachmentUrl,
  buildAttachmentKey,
  copyObject,
  isStorageConfigured,
  objectExists,
  readObject,
  writeObject,
} from "./storage";
export { lockChatStorageKeys } from "./storage-coordination";
// Media attachment enrichment cost/representation helpers. `chat`
// (`chat-history-retrieval` and `compaction`) read these through this seam;
// the enrichment implementation stays private to this `attachments` folder.
export {
  CHAT_ATTACHMENT_REPRESENTATION_VERSION,
  chatAttachmentRepresentationSchema,
  estimateAttachmentEnrichmentCostMicrousd,
  selectAttachmentsWithinEnrichmentBudget,
  shouldStartMediaEnrichment,
} from "./attachment-enrichment";
