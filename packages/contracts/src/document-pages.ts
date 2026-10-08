import { z } from "zod";
import { isValidPage } from "./guards";

/** One page's `[start, end)` range in the document content, in UTF-16 code units. */
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

/** `metadata.pages`. Empty pages are dropped, so page numbers can have gaps. */
export const documentPagesSchema = z.array(documentPageOffsetSchema);

export type DocumentPages = z.infer<typeof documentPagesSchema>;

/** Legacy `{page,text}` shape on old rows. New writers emit offsets. */
export const documentPageTextSchema = z.object({
  page: z.number().refine(isValidPage, "page must be a positive integer"),
  text: z.string(),
});

export type DocumentPageText = z.infer<typeof documentPageTextSchema>;

export const documentPagesMixedSchema = z.array(
  z.union([documentPageOffsetSchema, documentPageTextSchema]),
);

export type DocumentPagesMixed = z.infer<typeof documentPagesMixedSchema>;

/** Parse offset pages. Legacy `{page,text}` rows return `null`. */
export function parseDocumentPages(raw: unknown): DocumentPages | null {
  if (!Array.isArray(raw)) return null;
  const parsed = documentPagesSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
}

/** Parse pages that can include legacy `{page,text}` entries. */
export function parseDocumentPagesMixed(raw: unknown): DocumentPagesMixed | null {
  if (!Array.isArray(raw)) return null;
  const parsed = documentPagesMixedSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
}
