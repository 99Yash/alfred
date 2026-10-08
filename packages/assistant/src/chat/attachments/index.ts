// Internal barrel for chat attachment storage. It imports nothing from its siblings.
export {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
  assertStoredAttachmentBytesMatch,
  assertStoredAttachmentReady,
  assertUploadAllowed,
  sniffPassThroughImageMime,
  toAttachmentRow,
  type AttachmentDegradation,
} from "./attachments";

export {
  attachmentObjectKeys,
  attachmentUrl,
  buildAttachmentKey,
  copyObject,
  degradedArtifactKeysFor,
  isStorageConfigured,
  objectExists,
  pdfDegradedArtifactKey,
  readObject,
  writeObject,
} from "./storage";

export { lockChatStorageKeys, withChatStorageKeyLock } from "./storage-coordination";

export {
  CHAT_ATTACHMENT_REPRESENTATION_VERSION,
  chatAttachmentRepresentationSchema,
  estimateAttachmentEnrichmentCostMicrousd,
  selectAttachmentsWithinEnrichmentBudget,
  shouldStartMediaEnrichment,
} from "./attachment-enrichment";
