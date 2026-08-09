import { z } from "zod";
import { isRecord } from "./guards";

const nullableStringField = z.string().nullable().optional();
const labelIdsField = z.array(z.string()).optional();
const isSentField = z.boolean().optional();

/**
 * The shared, persisted Gmail projection stored in `documents.metadata`.
 *
 * The metadata column is an additive JSON bag, so this schema preserves keys
 * owned by other Gmail ingestion features. Direct schema use is strict so an
 * invalid writer fails at its owning seam. The parser below is lenient for
 * legacy rows: it drops an invalid known field without discarding valid peers.
 */
export const gmailDocumentMetadataSchema = z
  .object({
    from: nullableStringField,
    to: nullableStringField,
    cc: nullableStringField,
    snippet: nullableStringField,
    labelIds: labelIdsField,
    isSent: isSentField,
  })
  .passthrough();

export type GmailDocumentMetadata = z.infer<typeof gmailDocumentMetadataSchema>;
type GmailDocumentMetadataKey = keyof typeof gmailDocumentMetadataSchema.shape;

/** Parse persisted Gmail metadata into its canonical typed view. */
export function parseGmailDocumentMetadata(raw: unknown): GmailDocumentMetadata {
  const candidate = isRecord(raw) ? { ...raw } : {};
  repairPersistedField(candidate, "from", nullableStringField);
  repairPersistedField(candidate, "to", nullableStringField);
  repairPersistedField(candidate, "cc", nullableStringField);
  repairPersistedField(candidate, "snippet", nullableStringField);
  repairPersistedField(candidate, "labelIds", labelIdsField);
  repairPersistedField(candidate, "isSent", isSentField);
  return gmailDocumentMetadataSchema.parse(candidate);
}

function repairPersistedField(
  candidate: Record<string, unknown>,
  key: GmailDocumentMetadataKey,
  schema: z.ZodType<unknown>,
): void {
  if (!(key in candidate)) return;
  if (!schema.safeParse(candidate[key]).success) delete candidate[key];
}
