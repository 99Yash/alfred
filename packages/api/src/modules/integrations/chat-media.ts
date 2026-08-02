import { z } from "zod";

const identifierSchema = z.string().min(1).max(500);
const storageKeySchema = z.string().min(1).max(2_000);
const countSchema = z.number().int().nonnegative();

const attachmentRequestSchema = z.object({ attachmentId: identifierSchema }).strict();
const enrichmentRequestSchema = z
  .object({
    userId: identifierSchema,
    attachmentId: identifierSchema,
    estimatedCostMicrousd: countSchema,
  })
  .strict();
const prefixCleanupRequestSchema = z
  .object({ userId: identifierSchema, prefix: storageKeySchema })
  .strict();
const pendingUploadCleanupRequestSchema = z
  .object({
    userId: identifierSchema,
    // A defensive batch bound. Current jobs contain one key.
    keys: z.array(storageKeySchema).max(10_000),
  })
  .strict();

const claimResultSchema = z.enum(["claimed", "existing"]);
const enrichmentResultSchema = z.enum(["persisted", "superseded", "missing"]);
const storageUnconfiguredResultSchema = z
  .object({ removed: z.literal(0), skipped: z.literal("storage-unconfigured") })
  .strict();
const prefixCleanupResultSchema = z.object({ removed: countSchema }).strict();
const pendingUploadCleanupResultSchema = z
  .object({ checked: countSchema, removed: countSchema })
  .strict();

const prefixResultSchema = z.union([storageUnconfiguredResultSchema, prefixCleanupResultSchema]);
const pendingUploadResultSchema = z.union([
  storageUnconfiguredResultSchema,
  pendingUploadCleanupResultSchema,
]);

export type ChatMediaEnrichmentRequest = z.infer<typeof enrichmentRequestSchema>;
export type ChatMediaPrefixCleanupRequest = z.infer<typeof prefixCleanupRequestSchema>;
export type ChatMediaPendingUploadCleanupRequest = z.infer<
  typeof pendingUploadCleanupRequestSchema
>;
export type ChatMediaPrefixCleanupResult = z.infer<typeof prefixResultSchema>;
export type ChatMediaPendingUploadCleanupResult = z.infer<typeof pendingUploadResultSchema>;

export interface ChatMediaHandler {
  claimEnrichment(
    request: z.infer<typeof attachmentRequestSchema>,
  ): Promise<"claimed" | "existing">;
  recordEnqueueFailure(request: z.infer<typeof attachmentRequestSchema>): Promise<void>;
  enrich(request: ChatMediaEnrichmentRequest): Promise<z.infer<typeof enrichmentResultSchema>>;
  cleanupPrefix(request: ChatMediaPrefixCleanupRequest): Promise<ChatMediaPrefixCleanupResult>;
  cleanupPendingUploads(
    request: ChatMediaPendingUploadCleanupRequest,
  ): Promise<ChatMediaPendingUploadCleanupResult>;
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

function handler(): ChatMediaHandler {
  if (!chatMediaHandler) throw new NoChatMediaHandlerRegisteredError();
  return chatMediaHandler;
}

export async function claimChatMediaEnrichment(request: unknown): Promise<"claimed" | "existing"> {
  const parsed = attachmentRequestSchema.parse(request);
  return claimResultSchema.parse(await handler().claimEnrichment(parsed));
}

export async function recordChatMediaEnqueueFailure(request: unknown): Promise<void> {
  const parsed = attachmentRequestSchema.parse(request);
  await handler().recordEnqueueFailure(parsed);
}

export async function enrichChatMedia(
  request: unknown,
): Promise<z.infer<typeof enrichmentResultSchema>> {
  const parsed = enrichmentRequestSchema.parse(request);
  return enrichmentResultSchema.parse(await handler().enrich(parsed));
}

export async function cleanupChatMediaPrefix(
  request: unknown,
): Promise<ChatMediaPrefixCleanupResult> {
  const parsed = prefixCleanupRequestSchema.parse(request);
  return prefixResultSchema.parse(await handler().cleanupPrefix(parsed));
}

export async function cleanupPendingChatMediaUploads(
  request: unknown,
): Promise<ChatMediaPendingUploadCleanupResult> {
  const parsed = pendingUploadCleanupRequestSchema.parse(request);
  return pendingUploadResultSchema.parse(await handler().cleanupPendingUploads(parsed));
}
