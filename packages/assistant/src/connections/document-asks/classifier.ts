import { collapseWhitespace } from "@alfred/contracts";
import type { ContentFormat, DocumentAskKind } from "@alfred/contracts";

/**
 * Heading rules for attachment evidence. Biased to false negatives: a `resolved` ask never reopens.
 * A match needs its own primary heading, no fully present veto group, and two supporting markers.
 * Keep the supporting sets disjoint so no heading counts twice. A veto heading may overlap the
 * other kind's supporting markers, because vetoes are never counted.
 */
type MarkerPolicy = {
  primary: RegExp;
  supporting: readonly RegExp[];
  /** The kind is vetoed when every heading in one group is present. */
  vetoes: readonly (readonly RegExp[])[];
};

const RESUME_PRIMARY =
  /^(?:curriculum vitae|resume|résumé|employment history|professional experience|work experience)$/iu;

const PORTFOLIO_PRIMARY = /^(?:portfolio|selected work|selected projects|personal website)$/iu;

const EDUCATION = /^education(?: and training)?$/iu;

const SKILLS = /^(?:technical |professional )?skills$/iu;

/** Job ads reuse resume headings. */
const JOB_POSTING =
  /^(?:responsibilities|requirements|(?:minimum |preferred )?qualifications|about the role|about us|who you are|what you(?:'ll| will) do|what we offer|perks(?: (?:and|&) benefits)?|benefits)$/iu;

/** Resume headings outside the resume primary set: a designer resume often has no primary. */
const EMPLOYMENT_RECORD =
  /^(?:experience|relevant experience|work history|career history|employment)$/iu;

const DOCUMENT_ASK_CONTENT_MARKERS = {
  version: 3,
  resume: {
    primary: RESUME_PRIMARY,
    supporting: [EDUCATION, SKILLS, /^certifications$/iu, /^(?:professional )?summary$/iu],
    vetoes: [[PORTFOLIO_PRIMARY], [JOB_POSTING]],
  },
  portfolio: {
    primary: PORTFOLIO_PRIMARY,
    supporting: [
      /^about(?: me)?$/iu,
      /^case stud(?:y|ies)$/iu,
      /^(?:design )?process$/iu,
      /^(?:awards|exhibitions)$/iu,
    ],
    vetoes: [[RESUME_PRIMARY], [JOB_POSTING], [EMPLOYMENT_RECORD], [EDUCATION, SKILLS]],
  },
  minimumSupportingMarkers: 2,
} as const satisfies { version: number; minimumSupportingMarkers: number } & {
  [K in DocumentAskKind]: MarkerPolicy;
};

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

function matchesPolicy(lines: readonly string[], policy: MarkerPolicy): boolean {
  if (!hasHeading(lines, policy.primary)) return false;

  if (policy.vetoes.some((group) => group.every((marker) => hasHeading(lines, marker)))) {
    return false;
  }

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
  const isResume = matchesPolicy(lines, resume);
  const isPortfolio = matchesPolicy(lines, portfolio);

  if (isResume === isPortfolio) return null;

  return isResume ? "resume" : "portfolio";
}
