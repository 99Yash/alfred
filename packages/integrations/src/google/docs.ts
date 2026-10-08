import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/**
 * Docs v1 client, read-only. `getDocument` flattens the nested tree to text and a
 * heading outline, so a long doc does not flood the model's context.
 * Callers pass a token from `getFreshAccessToken(credentialId)`.
 */

const API_BASE = "https://docs.googleapis.com/v1/documents";

const textRunSchema = z.object({
  content: z.string().optional(),
});

const paragraphElementSchema = z.object({
  textRun: textRunSchema.optional(),
});

const paragraphSchema = z.object({
  elements: z.array(paragraphElementSchema).optional(),
  paragraphStyle: z.object({ namedStyleType: z.string().optional() }).optional(),
});

// Lazy, because table cells nest StructuralElements.
const structuralElementSchema: z.ZodType<StructuralElement> = z.lazy(() =>
  z.object({
    paragraph: paragraphSchema.optional(),
    table: tableSchema.optional(),
  }),
);

const tableCellSchema = z.object({
  content: z.array(structuralElementSchema).optional(),
});

const tableRowSchema = z.object({
  tableCells: z.array(tableCellSchema).optional(),
});

const tableSchema = z.object({
  tableRows: z.array(tableRowSchema).optional(),
});

interface StructuralElement {
  paragraph?: z.infer<typeof paragraphSchema> | undefined;
  table?: z.infer<typeof tableSchema> | undefined;
}

const documentSchema = z.object({
  documentId: z.string(),
  title: z.string().optional(),
  revisionId: z.string().optional(),
  body: z.object({ content: z.array(structuralElementSchema).optional() }).optional(),
});

const HEADING_STYLES = new Set([
  "TITLE",
  "SUBTITLE",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "HEADING_4",
  "HEADING_5",
  "HEADING_6",
]);

export interface DocumentHeading {
  /** e.g. `HEADING_1` or `TITLE`. */
  style: string;
  text: string;
}

export interface GetDocumentArgs {
  accessToken: string;
  documentId: string;
}

export interface GetDocumentResult {
  documentId: string;
  title?: string | undefined;
  revisionId?: string | undefined;
  /** Tables are flattened in reading order. */
  text: string;
  headings: DocumentHeading[];
}

export async function getDocument(
  args: GetDocumentArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GetDocumentResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.documentId)}`;
  const parsed = await getJson(documentSchema, url, args.accessToken, retry);

  const lines: string[] = [];
  const headings: DocumentHeading[] = [];

  for (const element of parsed.body?.content ?? []) {
    collectElement(element, lines, headings);
  }

  return {
    documentId: parsed.documentId,
    title: parsed.title,
    revisionId: parsed.revisionId,
    text: lines.join("\n"),
    headings,
  };
}

function collectElement(
  element: StructuralElement,
  lines: string[],
  headings: DocumentHeading[],
): void {
  if (element.paragraph) {
    const text = (element.paragraph.elements ?? [])
      .map((el) => el.textRun?.content ?? "")
      .join("")
      .replace(/\n+$/, "");

    if (text.length > 0) lines.push(text);
    const style = element.paragraph.paragraphStyle?.namedStyleType;

    if (style && HEADING_STYLES.has(style) && text.length > 0) {
      headings.push({ style, text });
    }

    return;
  }

  if (element.table) {
    for (const row of element.table.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        for (const cellElement of cell.content ?? []) {
          collectElement(cellElement, lines, headings);
        }
      }
    }
  }
}

const getJson = <T>(
  schema: z.ZodType<T>,
  url: string,
  accessToken: string,
  retry: RetryPolicy | "none",
): Promise<T> =>
  googleJson("docs", "GET", url, accessToken, undefined, retry).then((raw) => schema.parse(raw));
