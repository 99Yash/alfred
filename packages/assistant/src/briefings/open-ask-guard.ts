import {
  canonicalizeGithubPullRequestUrl,
  closesOpenAsk,
  collectGithubPullRequestUrls,
  type BriefingClosedLoop,
  type LoopClosingStateCategory,
} from "@alfred/contracts";
import { proposeObjectKeys, reconcileEvidence } from "@alfred/assistant/connections";

/**
 * Pre-send open-ask guard (#1082). A composer once asked the user to review a PR
 * it could see was merged, so this check sits outside the prompt.
 * After compose, it finds every work object the prose names and rejects an ask
 * about one the projection proved closed (ADR-0048 D).
 * Limits: it only blocks a draft or drops a sentence, never rewrites or reflows prose.
 * It writes nothing and makes no model call. Absence never closes a loop.
 */

/**
 * The guard reconciles the whole briefing as one subject. A bare `#51` needs
 * the briefing-wide list to bind, so a subject per sentence would not work.
 */
const GUARD_SUBJECT_ID = "composed-briefing";

/** The three strings that reach the user. */
export interface ComposedBriefingBody {
  subject: string;
  bodyText: string;
  bodyMarkdown: string;
}

export type BriefingBodyField = keyof ComposedBriefingBody;

const BRIEFING_BODY_FIELDS = ["subject", "bodyText", "bodyMarkdown"] as const;

/** Keyed by the canonical URL the prose must match. */
export interface ClosedObjectFact {
  url: string;
  stateCategory: LoopClosingStateCategory;
  title: string | null;
  /** The email that opened the loop, when the fact came from gather. */
  documentId: string | null;
}

export interface OpenAskViolation {
  field: BriefingBodyField;
  /** Verbatim. Named back to the composer. */
  sentence: string;
  objectUrl: string;
  objectTitle: string | null;
  stateCategory: LoopClosingStateCategory;
  marker: string;
  /**
   * The email that opened the loop. Null for a live read, which never saw the email.
   * The workflow keeps this document out of `surfacedDocumentIds`, or the next slot
   * would treat an undelivered item as already told.
   */
  documentId: string | null;
}

/**
 * Report each place the briefing asks the user to act on a closed object.
 * Closure comes from this run's `closedLoops` or a live `integration_objects` read.
 * The live read also covers `get_day_shape.shipped` objects.
 */
export async function auditComposedBriefing(args: {
  userId: string;
  composed: ComposedBriefingBody;
  closedLoops: readonly BriefingClosedLoop[];
}): Promise<OpenAskViolation[]> {
  const text = fullText(args.composed);
  const named = collectGithubPullRequestUrls(text);

  if (named.length === 0) return [];

  const closedByUrl = new Map<string, ClosedObjectFact>();

  for (const loop of args.closedLoops) {
    const url = loop.objectUrl ? canonicalizeGithubPullRequestUrl({ url: loop.objectUrl }) : null;

    if (!url || !named.includes(url)) continue;
    closedByUrl.set(url, {
      url,
      stateCategory: loop.stateCategory,
      title: loop.objectTitle,
      documentId: loop.documentId,
    });
  }

  // `mentions` proposes every named object. `reconcileEvidence` (#1088) keeps "closed"
  // the same as in gather.
  const subject = { id: GUARD_SUBJECT_ID, text: { subject: "", content: text } };

  const reconciled = await reconcileEvidence({
    userId: args.userId,
    subjects: [{ id: GUARD_SUBJECT_ID, keys: proposeObjectKeys(subject, { reading: "mentions" }) }],
  });

  for (const object of reconciled.get(GUARD_SUBJECT_ID) ?? []) {
    // Only URL keys can go in a URL-keyed map. Today `mentions` proposes nothing else.
    if (object.key.keyKind !== "pull_request_url") continue;
    const url = object.key.keyValue;

    // A gather closure wins: same row, and it knows which email opened the loop.
    // `closesAskAs === null` means this reading (`annotates`) may not close at all.
    if (object.closesAskAs === null || closedByUrl.has(url)) continue;

    // `closesAskAs` only nominates. The guard has no live read, so it asserts with
    // stored projection; a `live_confirmation` kind suppresses nothing here (ADR-0103).
    const closes = closesOpenAsk(
      object.state.provider,
      object.state.kind,
      object.state.stateCategory,
      "stored_projection",
    );

    if (closes === null) continue;
    closedByUrl.set(url, {
      url,
      stateCategory: closes,
      title: object.state.title,
      documentId: null,
    });
  }

  if (closedByUrl.size === 0) return [];

  return findOpenAskViolations({ composed: args.composed, named, closedByUrl });
}

/**
 * Report each sentence that names a closed object and carries an open-ask phrase.
 * A bare `#51` binds only when exactly one object in `named` has that number.
 * A marker hit fully inside the closed object's own title is skipped:
 * "Follow up on the #1082 review" is a name, not an ask. The span check means
 * a short title cannot hide a longer ask around it.
 */
export function findOpenAskViolations(args: {
  composed: ComposedBriefingBody;
  named: readonly string[];
  closedByUrl: ReadonlyMap<string, ClosedObjectFact>;
}): OpenAskViolation[] {
  const byNumber = bindableNumbers(args.named);
  const violations: OpenAskViolation[] = [];

  for (const field of BRIEFING_BODY_FIELDS) {
    for (const sentence of splitSentences(args.composed[field])) {
      const bound = objectsBoundTo(sentence.text, byNumber)
        .map((url) => args.closedByUrl.get(url))
        .filter((closed): closed is ClosedObjectFact => closed !== undefined);

      if (bound.length === 0) continue;

      const marker = findOpenAskMarker(
        sentence.text,
        bound.map((closed) => closed.title),
      );

      if (!marker) continue;

      for (const closed of bound) {
        violations.push({
          field,
          sentence: sentence.text.trim(),
          objectUrl: closed.url,
          objectTitle: closed.title,
          stateCategory: closed.stateCategory,
          marker,
          documentId: closed.documentId,
        });
      }
    }
  }

  return violations;
}

/**
 * Drop each violating sentence from both bodies.
 * Returns `null` if the subject violates or a body loses all prose; the caller fails the compose.
 * Writing replacement prose would be an assertion, which the guard may not make.
 */
export function downgradeOpenAsks(
  composed: ComposedBriefingBody,
  violations: readonly OpenAskViolation[],
): ComposedBriefingBody | null {
  if (violations.some((violation) => violation.field === "subject")) return null;

  const bodyText = dropSentences(composed.bodyText, violatingSentences(violations, "bodyText"));

  const bodyMarkdown = dropSentences(
    composed.bodyMarkdown,
    violatingSentences(violations, "bodyMarkdown"),
  );

  if (!bodyText || !bodyMarkdown) return null;

  return { subject: composed.subject, bodyText, bodyMarkdown };
}

export function describeOpenAskViolation(violation: OpenAskViolation): string {
  const object = violation.objectTitle
    ? `${violation.objectUrl} ("${violation.objectTitle}")`
    : violation.objectUrl;

  return (
    `${object} is ${violation.stateCategory}, but ${violation.field} ` +
    `says "${violation.marker}" in: "${violation.sentence}"`
  );
}

// ─── Detection internals ──────────────────────────────────────────────────

/**
 * Phrases that mark an object as work the user still owes.
 * Multi-word on purpose: a bare "review" shows up in honest recaps.
 * Present tense only (#1240): "followed up on" and "got your approval" do not match.
 */
const OPEN_ASK_MARKERS = [
  "action needed",
  "approve it",
  "awaiting review",
  "awaiting your",
  "blocked on you",
  "blocked on your",
  "flagged for your review",
  "follow up on",
  "give it a look",
  "have a look",
  "merge it",
  "most pressing",
  "needs a decision",
  "needs a look",
  "needs action",
  "needs review",
  "needs your approval",
  "needs your attention",
  "needs your eye",
  "needs your review",
  "needs your sign-off",
  "open ask",
  "pending your",
  "review it",
  "review this",
  "sign off on",
  "still needs",
  "still open",
  "still pending",
  "still unreviewed",
  "still waiting",
  "take a look",
  "unreviewed",
  "up for review",
  "waiting for your",
  "waiting on you",
  "you need to",
  "you should review",
] as const;

/**
 * A negation right before the marker means it is not an ask ("nothing needs your review").
 * Allows a `longer` or `need to` tail, and both apostrophes in `n't`.
 * Looks only at the text just before the phrase, so it cannot excuse a real ask in another clause.
 */
const NEGATION_BEFORE_RE =
  /(?:\b(?:no|not|nothing|none|never|nobody)\b|n['’]t)(?:\s+longer)?(?:\s+need\s+to)?[\s,]*$/;

const NEGATION_LOOKBACK = 24;

function findOpenAskMarker(sentence: string, titles: readonly (string | null)[]): string | null {
  const haystack = sentence.toLowerCase();
  const spans = titleSpans(haystack, titles);

  for (const marker of OPEN_ASK_MARKERS) {
    let from = 0;

    for (;;) {
      const at = haystack.indexOf(marker, from);

      if (at === -1) break;

      if (spans.some((span) => at >= span.start && at + marker.length <= span.end)) {
        from = at + 1;
        continue;
      }

      const before = haystack.slice(Math.max(0, at - NEGATION_LOOKBACK), at);

      if (!NEGATION_BEFORE_RE.test(before)) return marker;
      from = at + marker.length;
    }
  }

  return null;
}

/**
 * Word-bounded spans of each closed title in the lower-cased haystack.
 * "Review" matches in "please review it" but not in "reviews".
 */
function titleSpans(
  haystack: string,
  titles: readonly (string | null)[],
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];

  for (const title of titles) {
    const needle = title?.trim().toLowerCase();

    if (!needle) continue;
    let from = 0;

    for (;;) {
      const at = haystack.indexOf(needle, from);

      if (at === -1) break;

      const end = at + needle.length;

      const beforeOk =
        at === 0 || !isWordChar(haystack[at - 1] ?? "") || !isWordChar(needle[0] ?? "");

      const afterOk =
        end === haystack.length ||
        !isWordChar(haystack[end] ?? "") ||
        !isWordChar(needle[needle.length - 1] ?? "");

      if (beforeOk && afterOk) spans.push({ start: at, end });
      from = at + 1;
    }
  }

  return spans;
}

function isWordChar(char: string): boolean {
  return char.length === 1 && /[\p{L}\p{N}_]/u.test(char);
}

/** PR number to its object. A number two objects share is left out, so `#51` binds to nothing. */
function bindableNumbers(named: readonly string[]): ReadonlyMap<string, string> {
  const byNumber = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const url of named) {
    const number = url.slice(url.lastIndexOf("/") + 1);

    if (byNumber.has(number)) {
      ambiguous.add(number);
      continue;
    }

    byNumber.set(number, url);
  }

  for (const number of ambiguous) byNumber.delete(number);

  return byNumber;
}

const BARE_NUMBER_RE = /#(\d+)\b/g;

function objectsBoundTo(sentence: string, byNumber: ReadonlyMap<string, string>): string[] {
  const urls = new Set(collectGithubPullRequestUrls(sentence));

  for (const match of sentence.matchAll(BARE_NUMBER_RE)) {
    const url = match[1] ? byNumber.get(match[1]) : undefined;

    if (url) urls.add(url);
  }

  return [...urls];
}

interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Split into droppable spans: sentences, paragraphs, and list items.
 * Bullets have no end punctuation, so without the list split one bad bullet
 * dropped the whole list (#1082 B1). A single `\n` does not split.
 */
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+|\n\s*\n+|\n(?=\s*(?:[-*•>]|\d+[.)])\s)/g;

function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;

  for (const match of text.matchAll(SENTENCE_BOUNDARY_RE)) {
    const end = match.index;
    const piece = text.slice(start, end);

    if (piece.trim()) spans.push({ text: piece, start, end });
    start = end + match[0].length;
  }

  const tail = text.slice(start);

  if (tail.trim()) spans.push({ text: tail, start, end: text.length });

  return spans;
}

function violatingSentences(
  violations: readonly OpenAskViolation[],
  field: BriefingBodyField,
): ReadonlySet<string> {
  return new Set(
    violations
      .filter((violation) => violation.field === field)
      .map((violation) => violation.sentence),
  );
}

/**
 * Drop sentences by span. Each kept span carries the separator after it,
 * so the remaining text stays byte-identical. Only the edges are trimmed.
 * No global whitespace pass: it would break code fences, tables, and list indents.
 */
function dropSentences(text: string, sentences: ReadonlySet<string>): string {
  if (sentences.size === 0) return text;

  const spans = splitSentences(text);
  let out = "";

  for (const [index, span] of spans.entries()) {
    if (sentences.has(span.text.trim())) continue;
    const next = spans[index + 1];

    out += span.text + (next ? text.slice(span.end, next.start) : text.slice(span.end));
  }

  return out.trim();
}

/**
 * Remove the blamed documents from `surfacedDocumentIds`: they were never delivered,
 * and the next slot would mark them `previouslySurfaced`.
 * A violation with `documentId: null` filters nothing. That is a known gap.
 */
export function filterDroppedCitations(
  citedDocumentIds: readonly string[],
  violations: readonly OpenAskViolation[],
): string[] {
  const dropped = new Set<string>();

  for (const violation of violations) {
    if (violation.documentId) dropped.add(violation.documentId.trim());
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of citedDocumentIds) {
    const trimmed = value.trim();

    if (!trimmed || seen.has(trimmed) || dropped.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function fullText(composed: ComposedBriefingBody): string {
  return `${composed.subject}\n${composed.bodyText}\n${composed.bodyMarkdown}`;
}
