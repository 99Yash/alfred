import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { withDefaults } from "@alfred/contracts";
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
} from "@alfred/assistant/conversations";
import { deleteObjects, deletePrefix, isStorageConfigured } from "@alfred/assistant/conversations";
import { lockChatStorageKeys } from "@alfred/assistant/conversations";

interface ChatMediaAdapterDeps {
  claimEnrichment(attachmentId: string): Promise<"claimed" | "existing">;
  recordEnqueueFailure(attachmentId: string): Promise<unknown>;
  enrich: typeof enrichClaimedChatAttachment;
  storageConfigured(): boolean;
  deletePrefix(prefix: string): Promise<number>;
  cleanupPendingUploads(request: ChatMediaPendingUploadCleanupRequest): Promise<number>;
}

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
    return deleteObjects(orphaned);
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

/** Build the chat adapter while keeping queue transport in integrations. */
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
      console.log(
        `[ingestion:worker] media.cleanup prefix=${request.prefix} removed=${removed} user=${request.userId}`,
      );
      return { removed };
    },

    async cleanupPendingUploads(request) {
      if (!deps.storageConfigured()) {
        return { removed: 0, skipped: "storage-unconfigured" };
      }
      const removed = await deps.cleanupPendingUploads(request);
      console.log(
        `[ingestion:worker] media.cleanup_pending_upload checked=${request.keys.length} removed=${removed} user=${request.userId}`,
      );
      return { checked: request.keys.length, removed };
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
