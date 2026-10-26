import { z } from "zod";
import { bootPort } from "@alfred/assistant/boot-port";
import { TriggerConsumerBootError } from "@alfred/assistant/triggers";

// Defensive process-local limits; normal Gmail identifiers and ingestion batches are far smaller.
const identifierSchema = z.string().min(1).max(500);

const identifierListSchema = z.array(identifierSchema).max(10_000);

export const gmailPostInsertTriageRequestSchema = z
  .object({
    credentialId: identifierSchema,
    userId: identifierSchema,
    reconcileThreadIds: identifierListSchema,
    protectedDocumentIds: identifierListSchema,
    replyReevalThreadIds: identifierListSchema,
  })
  .strict();

type GmailPostInsertTriageRequest = z.infer<typeof gmailPostInsertTriageRequestSchema>;

const liveInboundGmailDocumentSchema = z
  .object({
    threadId: identifierSchema,
    documentId: identifierSchema,
  })
  .strict();

export const gmailPostInsertTriageResultSchema = z
  .object({
    replyReevalTargets: z.array(liveInboundGmailDocumentSchema).max(10_000),
  })
  .strict();

export type GmailPostInsertTriageResult = z.infer<typeof gmailPostInsertTriageResultSchema>;

export const gmailTriageRelabelRequestSchema = z
  .object({
    userId: identifierSchema,
    sourceThreadId: identifierSchema,
  })
  .strict();

type GmailTriageRelabelRequest = z.infer<typeof gmailTriageRelabelRequestSchema>;

export const gmailTriageRelabelResultSchema = z.discriminatedUnion("applied", [
  z
    .object({
      applied: z.literal(true),
      appliedLabelId: identifierSchema,
    })
    .strict(),
  z
    .object({
      applied: z.literal(false),
      // Mirrors triage's ReconcileResult; the composition mapper fails the build on a new reason.
      reason: z.enum([
        "tag-not-found",
        "document-not-found",
        "target-unresolvable",
        "writes-disabled",
      ]),
    })
    .strict(),
]);

export type GmailTriageRelabelResult = z.infer<typeof gmailTriageRelabelResultSchema>;

export interface GmailTriageHandler {
  postInsert(request: GmailPostInsertTriageRequest): Promise<GmailPostInsertTriageResult>;
  relabel(request: GmailTriageRelabelRequest): Promise<GmailTriageRelabelResult>;
}

export class NoGmailTriageHandlerRegisteredError extends TriggerConsumerBootError {
  constructor() {
    super("[integrations] no Gmail triage handler is registered");
    this.name = "NoGmailTriageHandlerRegisteredError";
  }
}

const gmailTriageHandlerPort = bootPort<GmailTriageHandler>("Gmail triage handler", {
  missing: () => new NoGmailTriageHandlerRegisteredError(),
});

/** Register the triage adapter that runtime composition supplies. */
export function registerGmailTriageHandler(handler: GmailTriageHandler): () => void {
  return gmailTriageHandlerPort.install(handler);
}

/** Run post-insert triage work without exposing its implementation to ingestion. */
export async function runGmailPostInsertTriage(
  request: unknown,
): Promise<GmailPostInsertTriageResult> {
  const parsedRequest = gmailPostInsertTriageRequestSchema.parse(request);

  return gmailPostInsertTriageResultSchema.parse(
    await gmailTriageHandlerPort.read().postInsert(parsedRequest),
  );
}

/** Run one queued thread relabel without exposing its implementation to ingestion. */
export async function runGmailTriageRelabel(request: unknown): Promise<GmailTriageRelabelResult> {
  const parsedRequest = gmailTriageRelabelRequestSchema.parse(request);

  return gmailTriageRelabelResultSchema.parse(
    await gmailTriageHandlerPort.read().relabel(parsedRequest),
  );
}
