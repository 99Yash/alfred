import { collapseWhitespace } from "@alfred/contracts";
import type { ContentFormat, DocumentAskKind } from "@alfred/contracts";

/**
 * Heading rules for attachment evidence. Biased to false negatives: a `resolved` ask never reopens.
 * A match needs its own primary heading, no other primary, no job-posting heading
 * (job ads reuse resume headings), and two supporting markers.
 * Keep the marker sets disjoint so no heading counts twice.
 */
const DOCUMENT_ASK_CONTENT_MARKERS = {
  version: 2,
  resume: {
    primary:
      /^(?:curriculum vitae|resume|résumé|employment history|professional experience|work experience)$/iu,
    supporting: [
      /^education(?: and training)?$/iu,
      /^(?:technical |professional )?skills$/iu,
      /^certifications$/iu,
      /^(?:professional )?summary$/iu,
    ],
  },
  portfolio: {
    primary: /^(?:portfolio|selected work|selected projects|personal website)$/iu,
    supporting: [
      /^about(?: me)?$/iu,
      /^case stud(?:y|ies)$/iu,
      /^(?:design )?process$/iu,
      /^(?:awards|exhibitions)$/iu,
    ],
  },
  jobPosting:
    /^(?:responsibilities|requirements|about the role|what you(?:'ll| will) do|what we offer|benefits)$/iu,
  minimumSupportingMarkers: 2,
} as const;

type MarkerPolicy = (typeof DOCUMENT_ASK_CONTENT_MARKERS)[DocumentAskKind];

function hasHeading(lines: readonly string[], marker: RegExp): boolean {
  return lines.some((line) => marker.test(line));
}

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
  policy: MarkerPolicy,
  other: MarkerPolicy,
): boolean {
  if (!hasHeading(lines, policy.primary) || hasHeading(lines, other.primary)) return false;

  if (hasHeading(lines, DOCUMENT_ASK_CONTENT_MARKERS.jobPosting)) return false;

  const supporting = policy.supporting.filter((marker) => hasHeading(lines, marker));

  return supporting.length >= DOCUMENT_ASK_CONTENT_MARKERS.minimumSupportingMarkers;
}

/** Content only: `filename`, `mimeType`, and `format` are not signals. */
export function classifyGmailAttachmentContent(input: {
  content: string;
  filename: string | null;
  mimeType: string | null;
  format: ContentFormat;
}): DocumentAskKind | null {
  if (!input.content.trim()) return null;

  const lines = normalizedHeadingLines(input.content);
  const { resume, portfolio } = DOCUMENT_ASK_CONTENT_MARKERS;
  const isResume = matchesPolicy(lines, resume, portfolio);
  const isPortfolio = matchesPolicy(lines, portfolio, resume);

  if (isResume === isPortfolio) return null;

  return isResume ? "resume" : "portfolio";
}
