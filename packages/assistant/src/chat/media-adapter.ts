import { withDefaults } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import {
  registerChatMediaHandler,
  type ChatMediaHandler,
  type ChatMediaPendingUploadCleanupRequest,
} from "@alfred/assistant/connections/ingestion";
import {
  claimChatAttachmentEnrichment,
  enrichClaimedChatAttachment,
  recordChatAttachmentEnrichmentFailure,
} from "./attachments/attachment-enrichment";
import {
  attachmentObjectKeys,
  deleteObjects,
  deletePrefix,
  isStorageConfigured,
} from "./attachments/storage";
import { lockChatStorageKeys } from "./attachments/storage-coordination";
import { logger } from "@alfred/logging";

interface ChatMediaAdapterDeps {
  claimEnrichment(attachmentId: string): Promise<"claimed" | "existing">;
  recordEnqueueFailure(attachmentId: string): Promise<boolean>;
  enrich: typeof enrichClaimedChatAttachment;
  storageConfigured(): boolean;
  deletePrefix(prefix: string): Promise<number>;
  cleanupPendingUploads(request: ChatMediaPendingUploadCleanupRequest): Promise<number>;
}

/**
 * Delete only the pending-upload objects that no attachment row of this user retains.
 * The per-key lock is the same one attachment creation takes, so cleanup cannot
 * delete an object after its attachment row commits.
 */
async function cleanupPendingUploads(
  request: ChatMediaPendingUploadCleanupRequest,
): Promise<number> {
  if (request.keys.length === 0) return 0;

  return db().transaction(async (tx) => {
    await lockChatStorageKeys(tx, request.keys);

    const rows = await tx
      .select({ storageKey: chatAttachments.storageKey })
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.userId, request.userId),
          inArray(chatAttachments.storageKey, request.keys),
        ),
      );

    const retained = new Set(rows.map((row) => row.storageKey));
    const orphaned = request.keys.filter((key) => !retained.has(key));

    return deleteObjects(orphaned.flatMap(attachmentObjectKeys));
  });
}

const defaultDeps: ChatMediaAdapterDeps = {
  claimEnrichment: claimChatAttachmentEnrichment,
  recordEnqueueFailure: (attachmentId) =>
    recordChatAttachmentEnrichmentFailure(attachmentId, "enqueue_failed"),
  enrich: enrichClaimedChatAttachment,
  storageConfigured: isStorageConfigured,
  deletePrefix,
  cleanupPendingUploads,
};

/** Build the chat media handler. Overrides are an internal seam for adapter tests. */
export function createChatMediaHandler(
  dependencies: Partial<ChatMediaAdapterDeps> = {},
): ChatMediaHandler {
  const deps = withDefaults(defaultDeps, dependencies);

  return {
    claimEnrichment(request) {
      return deps.claimEnrichment(request.attachmentId);
    },

    async recordEnqueueFailure(request) {
      await deps.recordEnqueueFailure(request.attachmentId);
    },

    enrich(request) {
      return deps.enrich({
        attachmentId: request.attachmentId,
        estimatedCostMicrousd: request.estimatedCostMicrousd,
        attribution: {
          userId: request.userId,
          idempotencyKey: `media-enrich:${request.attachmentId}`,
          name: "chat.attachment-enrichment.background",
        },
      });
    },

    async cleanupPrefix(request) {
      if (!deps.storageConfigured()) {
        return { removed: 0, skipped: "storage-unconfigured" };
      }

      const removed = await deps.deletePrefix(request.prefix);
      logger.info(
        `[ingestion:worker] media.cleanup prefix=${request.prefix} removed=${removed} user=${request.userId}`,
      );

      return { removed };
    },

    async cleanupPendingUploads(request) {
      if (!deps.storageConfigured()) {
        return { removed: 0, skipped: "storage-unconfigured" };
      }

      const removed = await deps.cleanupPendingUploads(request);
      logger.info(
        `[ingestion:worker] media.cleanup_pending_upload checked=${request.keys.length} removed=${removed} user=${request.userId}`,
      );

      return { checked: request.keys.length, removed };
    },
  };
}

/**
 * Backs the ingestion-owned chat-media jobs. Lives in chat so ingestion never imports
 * chat; ingestion keeps the queue transport. Install before ingestion workers start.
 */
export function registerChatMediaAdapter(): () => void {
  return registerChatMediaHandler(createChatMediaHandler());
}
