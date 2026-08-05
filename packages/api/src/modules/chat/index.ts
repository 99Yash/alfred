// Public seam for the `chat` module. The chat HTTP routes and turn admission
// now live in `conversations`; what remains here is attachment storage and the
// storage-backed helpers the `conversations` recipe and routes consume. The
// `conversations` module imports these through this seam, never the reverse —
// `chat` imports nothing from `conversations`, so it stays a leaf.
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
