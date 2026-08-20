import { z } from "zod";
import { isValidPage } from "./guards";

/**
 * Page offset into a concatenated document content string.
 * `start` is inclusive, `end` is exclusive — proven by the extractor's
 * deterministic join with "\n\n" separators. Both are byte offsets in
 * JS string length (UTF-16 code units), not token counts.
 */
export const documentPageOffsetSchema = z
  .object({
    page: z.number().refine(isValidPage, "page must be a positive integer"),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .refine((v) => v.end >= v.start, {
    message: "end must be >= start",
    path: ["end"],
  });

export type DocumentPageOffset = z.infer<typeof documentPageOffsetSchema>;

/**
 * Ordered list of page offsets for a document's `metadata.pages`.
 * The extractor emits pages dense 1..N; the writer filters empty pages
 * but preserves offset arithmetic for the remaining ones.
 */
export const documentPagesSchema = z.array(documentPageOffsetSchema);

export type DocumentPages = z.infer<typeof documentPagesSchema>;

/**
 * Legacy text-embedded page shape — kept for backward compatibility with
 * readers that may encounter rows written before offset encoding. New
 * writers must emit offsets, not text.
 */
export const documentPageTextSchema = z.object({
  page: z.number().refine(isValidPage, "page must be a positive integer"),
  text: z.string(),
});

export type DocumentPageText = z.infer<typeof documentPageTextSchema>;

export const documentPagesMixedSchema = z.array(
  z.union([documentPageOffsetSchema, documentPageTextSchema]),
);

export type DocumentPagesMixed = z.infer<typeof documentPagesMixedSchema>;

/**
 * Parse `metadata.pages` from an untrusted jsonb payload. Returns the
 * offset-encoded pages when valid, otherwise `null`. Offset pages are the
 * canonical writer path (`{page,start,end}`). Legacy `{page,text}` rows
 * return `null` here — use `parseDocumentPagesMixed` when you need the
 * mixed fallback.
 */
export function parseDocumentPages(raw: unknown): DocumentPages | null {
  if (!Array.isArray(raw)) return null;
  const parsed = documentPagesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse `metadata.pages` that may contain legacy `{page,text}` entries.
 * Returns `null` only when the payload is not an array or fails the
 * mixed union. Callers that only handle offset pages should use
 * `parseDocumentPages` above.
 */
export function parseDocumentPagesMixed(raw: unknown): DocumentPagesMixed | null {
  if (!Array.isArray(raw)) return null;
  const parsed = documentPagesMixedSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
