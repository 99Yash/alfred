import { z } from "zod";
import { contentFormatSchema } from "./attachments";

/** The semantic document kinds an inbound Gmail request may ask for. */
export const DOCUMENT_ASK_KINDS = ["resume", "portfolio"] as const;

export const documentAskKindSchema = z.enum(DOCUMENT_ASK_KINDS);

export type DocumentAskKind = z.infer<typeof documentAskKindSchema>;

/** The dedicated document-ask lifecycle. `resolved` is absorbing. */
export const DOCUMENT_ASK_STATUSES = ["active", "resolved"] as const;

export const documentAskStatusSchema = z.enum(DOCUMENT_ASK_STATUSES);

export type DocumentAskStatus = z.infer<typeof documentAskStatusSchema>;

/** The only truthful local evidence provenance accepted by the reducer. */
export const documentAskEvidenceSourceSchema = z.literal("extracted_content");

export type DocumentAskEvidenceSource = z.infer<typeof documentAskEvidenceSourceSchema>;

/**
 * The classifier may propose only the semantic kind. Identity, Gmail direction,
 * carrier, and attachment evidence are owned by persisted rows, never by model
 * output.
 */
export const documentAskProposalSchema = z
  .object({
    requestedKind: documentAskKindSchema,
  })
  .strict();

export type DocumentAskProposal = z.infer<typeof documentAskProposalSchema>;

/**
 * One positive, content-derived observation for a canonical Gmail attachment
 * document. The queue boundary carries this narrow identity and hash/format
 * context only; extracted text stays in the documents row.
 */
export const documentAskEvidenceSchema = z
  .object({
    attachmentDocumentId: z.string().min(1),
    attachmentId: z.string().min(1),
    filename: z.string().nullable(),
    mimeType: z.string().nullable(),
    contentHash: z.string().min(1),
    format: contentFormatSchema,
    extraction: z.literal("extracted"),
    contentKind: documentAskKindSchema,
    evidence: documentAskEvidenceSourceSchema,
  })
  .strict();

export type DocumentAskEvidence = z.infer<typeof documentAskEvidenceSchema>;
