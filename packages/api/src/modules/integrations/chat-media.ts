import { z } from "zod";

const identifierSchema = z.string().min(1).max(500);
const storageKeySchema = z.string().min(1).max(2_000);
const countSchema = z.number().int().nonnegative();

export const chatAttachmentEnrichmentScheduleRequestSchema = z
  .object({
    userId: identifierSchema,
    attachmentId: identifierSchema,
    estimatedCostMicrousd: countSchema,
  })
  .strict();

export type ChatAttachmentEnrichmentScheduleRequest = z.infer<
  typeof chatAttachmentEnrichmentScheduleRequestSchema
>;

export const chatAttachmentEnrichmentScheduleResultSchema = z.enum(["scheduled", "existing"]);

export type ChatAttachmentEnrichmentScheduleResult = z.infer<
  typeof chatAttachmentEnrichmentScheduleResultSchema
>;

const chatMediaEnrichmentJobRequestSchema = chatAttachmentEnrichmentScheduleRequestSchema
  .extend({ kind: z.literal("enrich") })
  .strict();
const chatMediaPrefixCleanupJobRequestSchema = z
  .object({
    kind: z.literal("cleanup-prefix"),
    userId: identifierSchema,
    prefix: storageKeySchema,
  })
  .strict();
const chatMediaPendingUploadCleanupJobRequestSchema = z
  .object({
    kind: z.literal("cleanup-pending-uploads"),
    userId: identifierSchema,
    // A defensive batch bound. Current jobs contain one key.
    keys: z.array(storageKeySchema).max(10_000),
  })
  .strict();

export const chatMediaJobRequestSchema = z.discriminatedUnion("kind", [
  chatMediaEnrichmentJobRequestSchema,
  chatMediaPrefixCleanupJobRequestSchema,
  chatMediaPendingUploadCleanupJobRequestSchema,
]);

export type ChatMediaJobRequest = z.infer<typeof chatMediaJobRequestSchema>;
export type ChatMediaEnrichmentJobRequest = Extract<ChatMediaJobRequest, { kind: "enrich" }>;

const storageUnconfiguredResultSchema = z
  .object({ removed: z.literal(0), skipped: z.literal("storage-unconfigured") })
  .strict();
const prefixCleanupResultSchema = z.object({ removed: countSchema }).strict();
const pendingUploadCleanupResultSchema = z
  .object({ checked: countSchema, removed: countSchema })
  .strict();
const enrichmentResultSchema = z.enum(["persisted", "superseded", "missing"]);
const prefixJobResultSchema = z.union([storageUnconfiguredResultSchema, prefixCleanupResultSchema]);
const pendingUploadJobResultSchema = z.union([
  storageUnconfiguredResultSchema,
  pendingUploadCleanupResultSchema,
]);

export const chatMediaJobResultSchema = z.union([
  enrichmentResultSchema,
  storageUnconfiguredResultSchema,
  prefixCleanupResultSchema,
  pendingUploadCleanupResultSchema,
]);

export type ChatMediaJobResult = z.infer<typeof chatMediaJobResultSchema>;

export interface ChatMediaHandler {
  scheduleEnrichment(
    request: ChatAttachmentEnrichmentScheduleRequest,
  ): Promise<ChatAttachmentEnrichmentScheduleResult>;
  processJob(request: ChatMediaJobRequest): Promise<ChatMediaJobResult>;
}

export class NoChatMediaHandlerRegisteredError extends Error {
  constructor() {
    super("[integrations] no chat media handler is registered");
    this.name = "NoChatMediaHandlerRegisteredError";
  }
}

let chatMediaHandler: ChatMediaHandler | undefined;

/** Register the chat adapter that runtime composition supplies. */
export function registerChatMediaHandler(handler: ChatMediaHandler): () => void {
  if (chatMediaHandler) {
    throw new Error("[integrations] a chat media handler is already registered");
  }
  chatMediaHandler = handler;

  return () => {
    if (chatMediaHandler === handler) chatMediaHandler = undefined;
  };
}

/** Claim and enqueue one attachment without exposing chat persistence details. */
export async function scheduleChatAttachmentEnrichment(
  request: unknown,
): Promise<ChatAttachmentEnrichmentScheduleResult> {
  const parsedRequest = chatAttachmentEnrichmentScheduleRequestSchema.parse(request);
  if (!chatMediaHandler) throw new NoChatMediaHandlerRegisteredError();
  return chatAttachmentEnrichmentScheduleResultSchema.parse(
    await chatMediaHandler.scheduleEnrichment(parsedRequest),
  );
}

/** Process one queue-owned chat media job through the registered chat adapter. */
export async function processChatMediaJob(request: unknown): Promise<ChatMediaJobResult> {
  const parsedRequest = chatMediaJobRequestSchema.parse(request);
  if (!chatMediaHandler) throw new NoChatMediaHandlerRegisteredError();
  const result = await chatMediaHandler.processJob(parsedRequest);
  switch (parsedRequest.kind) {
    case "enrich":
      return enrichmentResultSchema.parse(result);
    case "cleanup-prefix":
      return prefixJobResultSchema.parse(result);
    case "cleanup-pending-uploads":
      return pendingUploadJobResultSchema.parse(result);
  }
}
