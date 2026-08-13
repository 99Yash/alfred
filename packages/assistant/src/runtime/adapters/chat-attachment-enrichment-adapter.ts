import type { ChatAttachmentEnrichmentScheduler } from "@alfred/assistant/triggers";
import {
  registerChatAttachmentEnrichmentScheduler as registerPort,
  unregisterChatAttachmentEnrichmentScheduler as unregisterPort,
} from "@alfred/assistant/triggers";
import { enqueueChatAttachmentEnrichment as concrete } from "@alfred/assistant/connections/ingestion";

export function registerChatAttachmentEnrichmentScheduler(
  scheduler?: ChatAttachmentEnrichmentScheduler,
): () => void {
  return registerPort(scheduler ?? { enqueueChatAttachmentEnrichment: concrete });
}

export function unregisterChatAttachmentEnrichmentScheduler(): void {
  unregisterPort();
}
