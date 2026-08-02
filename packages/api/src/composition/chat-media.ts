import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";
import {
  enqueueChatMediaEnrichmentJob,
  registerChatMediaHandler,
  type ChatMediaEnrichmentJobRequest,
  type ChatMediaHandler,
} from "../modules/integrations";
import {
  claimChatAttachmentEnrichment,
  enrichClaimedChatAttachment,
  recordChatAttachmentEnrichmentFailure,
} from "../modules/chat/attachment-enrichment";
import { deleteObjects, deletePrefix, isStorageConfigured } from "../modules/chat/storage";

interface ChatMediaAdapterDeps {
  claimEnrichment(attachmentId: string): Promise<"claimed" | "existing">;
  enqueueEnrichmentJob(request: ChatMediaEnrichmentJobRequest): Promise<void>;
  recordEnqueueFailure(attachmentId: string): Promise<unknown>;
  enrich: typeof enrichClaimedChatAttachment;
  storageConfigured(): boolean;
  deletePrefix(prefix: string): Promise<number>;
  loadRetainedKeys(keys: readonly string[]): Promise<string[]>;
  deleteObjects(keys: readonly string[]): Promise<number>;
}

async function loadRetainedKeys(keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db()
    .select({ storageKey: chatAttachments.storageKey })
    .from(chatAttachments)
    .where(inArray(chatAttachments.storageKey, keys));
  return rows.map((row) => row.storageKey);
}

const defaultDeps: ChatMediaAdapterDeps = {
  claimEnrichment: claimChatAttachmentEnrichment,
  enqueueEnrichmentJob: enqueueChatMediaEnrichmentJob,
  recordEnqueueFailure: (attachmentId) =>
    recordChatAttachmentEnrichmentFailure(attachmentId, "enqueue_failed"),
  enrich: enrichClaimedChatAttachment,
  storageConfigured: isStorageConfigured,
  deletePrefix,
  loadRetainedKeys,
  deleteObjects,
};

/** Build the chat adapter while keeping queue transport in integrations. */
export function createChatMediaHandler(
  dependencies: Partial<ChatMediaAdapterDeps> = {},
): ChatMediaHandler {
  const deps = { ...defaultDeps, ...dependencies };
  return {
    async scheduleEnrichment(request) {
      const claim = await deps.claimEnrichment(request.attachmentId);
      if (claim === "existing") return "existing";
      try {
        await deps.enqueueEnrichmentJob({ kind: "enrich", ...request });
        return "scheduled";
      } catch (error) {
        await deps.recordEnqueueFailure(request.attachmentId);
        throw error;
      }
    },

    async processJob(request) {
      switch (request.kind) {
        case "enrich":
          return deps.enrich({
            attachmentId: request.attachmentId,
            estimatedCostMicrousd: request.estimatedCostMicrousd,
            attribution: {
              userId: request.userId,
              idempotencyKey: `media-enrich:${request.attachmentId}`,
              name: "chat.attachment-enrichment.background",
            },
          });
        case "cleanup-prefix": {
          if (!deps.storageConfigured()) {
            return { removed: 0, skipped: "storage-unconfigured" };
          }
          const removed = await deps.deletePrefix(request.prefix);
          console.log(
            `[ingestion:worker] media.cleanup prefix=${request.prefix} removed=${removed} user=${request.userId}`,
          );
          return { removed };
        }
        case "cleanup-pending-uploads": {
          if (!deps.storageConfigured()) {
            return { removed: 0, skipped: "storage-unconfigured" };
          }
          const retained = new Set(await deps.loadRetainedKeys(request.keys));
          const orphaned = request.keys.filter((key) => !retained.has(key));
          const removed = await deps.deleteObjects(orphaned);
          console.log(
            `[ingestion:worker] media.cleanup_pending_upload checked=${request.keys.length} removed=${removed} user=${request.userId}`,
          );
          return { checked: request.keys.length, removed };
        }
      }
    },
  };
}

let unregisterChatMediaHandler: (() => void) | undefined;

/** Connect ingestion jobs to chat behavior without a private module import. */
export function registerChatMedia(): void {
  if (unregisterChatMediaHandler) return;
  unregisterChatMediaHandler = registerChatMediaHandler(createChatMediaHandler());
}

export function unregisterChatMedia(): void {
  unregisterChatMediaHandler?.();
  unregisterChatMediaHandler = undefined;
}
