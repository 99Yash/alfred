import { z } from "zod";

/**
 * Thin Google Docs v1 REST client. Same shape as `gmail.ts` /
 * `calendar.ts` — direct JSON calls, no `googleapis` dependency.
 *
 * Read-only: the granted scope is `documents.readonly` (see
 * `DOCS_READONLY_SCOPE` in oauth.ts), so the surface is just "fetch a
 * document and hand back its text". The Docs API returns a deeply nested
 * structural tree; `getDocument` walks it into plain text + a heading
 * outline, which is what an agent actually wants. The raw structure stays
 * out of the return so a long doc doesn't blow up the model's context.
 *
 * Callers pass an already-fresh access token — get it from
 * `getFreshAccessToken(credentialId)` first.
 */

const API_BASE = "https://docs.googleapis.com/v1/documents";

/** A text run carries the actual characters; everything else is layout. */
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

// Tables nest StructuralElements one level deeper; declared lazily so the
// recursive shape type-checks without a forward reference dance.
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
  paragraph?: z.infer<typeof paragraphSchema>;
  table?: z.infer<typeof tableSchema>;
}

const documentSchema = z.object({
  documentId: z.string(),
  title: z.string().optional(),
  revisionId: z.string().optional(),
  body: z.object({ content: z.array(structuralElementSchema).optional() }).optional(),
});

/** Named styles the Docs API uses for headings; everything else is body text. */
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
  /** The Docs named style, e.g. `HEADING_1` or `TITLE`. */
  style: string;
  text: string;
}

export interface GetDocumentArgs {
  accessToken: string;
  documentId: string;
}

export interface GetDocumentResult {
  documentId: string;
  title?: string;
  revisionId?: string;
  /** Full document text, paragraphs joined with newlines (tables flattened in reading order). */
  text: string;
  /** Heading outline in document order — handy for the model to navigate a long doc. */
  headings: DocumentHeading[];
}

/** Fetch a document and flatten its structure into plain text + a heading outline. */
export async function getDocument(args: GetDocumentArgs): Promise<GetDocumentResult> {
  const url = `${API_BASE}/${encodeURIComponent(args.documentId)}`;
  const json = await getJson(url, args.accessToken);
  const parsed = documentSchema.parse(json);

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

const DOCS_FETCH_TIMEOUT_MS = 30_000;

async function getJson(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(DOCS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[docs] ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  return res.json();
}
