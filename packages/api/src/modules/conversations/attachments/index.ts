// Internal barrel for `conversations` attachment storage. The chat HTTP routes,
// turn admission, compaction, and history retrieval all live in `conversations`;
// this folder holds the attachment storage, enrichment, and storage-coordination
// helpers those consume. It is an internal-only barrel — nothing outside
// `conversations` imports it, and it imports nothing from its siblings, so it
// stays a leaf inside the module.
export {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
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
// Media attachment enrichment cost/representation helpers. `agent`
// (`chat-history-retrieval`) and `conversations` (`compaction`) read these
// through this seam; the enrichment implementation stays private in `chat`.
export {
  CHAT_ATTACHMENT_REPRESENTATION_VERSION,
  chatAttachmentRepresentationSchema,
  estimateAttachmentEnrichmentCostMicrousd,
  selectAttachmentsWithinEnrichmentBudget,
  shouldStartMediaEnrichment,
} from "./attachment-enrichment";
