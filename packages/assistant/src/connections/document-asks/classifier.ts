import { collapseWhitespace } from "@alfred/contracts";
import type { ContentFormat, DocumentAskKind } from "@alfred/contracts";

/**
 * Versioned content-heading policy for Gmail attachment evidence. The policy is
 * deliberately asymmetric toward false negatives, because a `resolved` ask is
 * absorbing and nothing corrects a wrong close. A kind matches only when:
 *
 * - one of its primary headings is present,
 * - no primary heading of the other kind is present,
 * - no job-posting heading is present, because a job description reuses the
 *   resume headings (`work experience`, `skills`, `education`), and
 * - at least two distinct supporting markers match.
 *
 * Each supporting marker counts once, however many lines it matches. The
 * supporting sets are disjoint from both primary sets and from each other, so
 * one heading can never count twice. Headings both kinds use (`experience`,
 * `projects`, `work`, `contact`) are not markers at all. A filename, MIME type,
 * generic career word, or technical extraction format never selects a kind.
 *
 * Nothing persists a classification: the reducer reclassifies stored content
 * on every read, so `version` marks a policy change for review and replay
 * only. Version 2 made the sets disjoint and added the two vetoes.
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
  const { resume, portfolio } = DOCUMENT_ASK_CONTENT_MARKERS;
  const isResume = matchesPolicy(lines, resume, portfolio);
  const isPortfolio = matchesPolicy(lines, portfolio, resume);

  if (isResume === isPortfolio) return null;

  return isResume ? "resume" : "portfolio";
}
