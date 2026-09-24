import { collapseWhitespace } from "@alfred/contracts";
import type { ContentFormat, DocumentAskKind } from "@alfred/contracts";

/**
 * Versioned content-heading policy for Gmail attachment evidence. The policy is
 * deliberately asymmetric toward false negatives: one strong semantic heading
 * plus two independent supporting headings is required. A filename, MIME type,
 * generic career word, or technical extraction format never selects a kind.
 */
const DOCUMENT_ASK_CONTENT_MARKERS = {
  version: 1,
  resume: {
    primary:
      /^(?:curriculum vitae|resume|résumé|employment history|professional experience|work experience)$/iu,
    supporting:
      /^(?:education|education and training|skills|technical skills|professional skills|employment|experience|projects|certifications|professional summary|summary)$/iu,
    minimumSupportingHeadings: 2,
  },
  portfolio: {
    primary: /^(?:portfolio|selected work|selected projects|personal website)$/iu,
    supporting: /^(?:about|about me|projects|selected work|experience|design|contact|work)$/iu,
    minimumSupportingHeadings: 2,
  },
} as const;

function normalizedHeadingLines(content: string): string[] {
  return content
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^[-*•·]\s+/, ""))
    .map((line) => collapseWhitespace(line.replace(/[|:•·\t]+/g, " ")))
    .filter(Boolean);
}

function matchesPolicy(
  lines: readonly string[],
  policy: {
    primary: RegExp;
    supporting: RegExp;
    minimumSupportingHeadings: number;
  },
): boolean {
  const hasPrimary = lines.some((line) => policy.primary.test(line));

  if (!hasPrimary) return false;

  const supportingHeadings = new Set(
    lines.filter((line) => policy.supporting.test(line)).map((line) => line.toLowerCase()),
  );

  return supportingHeadings.size >= policy.minimumSupportingHeadings;
}

/**
 * Classify already-extracted attachment content into the semantic product kind
 * requested by a document ask. `filename`, `mimeType`, and `format` are caller
 * context and audit fields, intentionally not signals here.
 */
export function classifyGmailAttachmentContent(input: {
  content: string;
  filename: string | null;
  mimeType: string | null;
  format: ContentFormat;
}): DocumentAskKind | null {
  if (!input.content.trim()) return null;

  const lines = normalizedHeadingLines(input.content);
  const isResume = matchesPolicy(lines, DOCUMENT_ASK_CONTENT_MARKERS.resume);
  const isPortfolio = matchesPolicy(lines, DOCUMENT_ASK_CONTENT_MARKERS.portfolio);

  if (isResume === isPortfolio) return null;

  return isResume ? "resume" : "portfolio";
}
