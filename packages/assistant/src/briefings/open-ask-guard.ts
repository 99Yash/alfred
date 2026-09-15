import {
  canonicalizeGithubPullRequestUrl,
  collectGithubPullRequestUrls,
  isLoopClosingCategory,
  type BriefingClosedLoop,
  type LoopClosingStateCategory,
} from "@alfred/contracts";
import { objectStateStore } from "@alfred/assistant/connections";

/**
 * Pre-send open-ask guard (#1082) — the deterministic half of the closed-loop
 * rule #1080 put in the composer prompt.
 *
 * The composer of `brg_l49mbk1vf534` held the closure fact in its own context
 * and asked the user to review a merged PR anyway. A model that contradicts a
 * fact it can see will do it again, so the guarantee sits outside the prompt:
 * after compose and before send, read the composed prose, resolve every work
 * object it names, and reject a draft that asks the user to act on an object
 * the projection has already proved closed.
 *
 * Powers and limits (ADR-0048 decision D, and the #257 boundary this shares):
 *   - It may only BLOCK a draft or DROP a sentence. It never writes prose, and
 *     it never asserts on its own that an object closed.
 *   - It reads `integration_objects` and writes nothing. No durable state moves.
 *   - It makes no model call. The re-prompt it triggers is the workflow's call,
 *     not the guard's.
 *   - Absence never closes a loop. An object with no row, an unreadable state,
 *     a provider this build does not project, or a state category that is not
 *     loop-closing all leave the draft alone.
 */

/** The three composed strings that reach the user. The guard checks all three. */
export interface ComposedBriefingBody {
  subject: string;
  bodyText: string;
  bodyMarkdown: string;
}

export type BriefingBodyField = keyof ComposedBriefingBody;

const BRIEFING_BODY_FIELDS = ["subject", "bodyText", "bodyMarkdown"] as const;

/** One closed work object, keyed by the canonical URL the prose must match. */
export interface ClosedObjectFact {
  url: string;
  stateCategory: LoopClosingStateCategory;
  title: string | null;
}

export interface OpenAskViolation {
  field: BriefingBodyField;
  /** The whole sentence that carries the ask, verbatim. Named back to the composer. */
  sentence: string;
  objectUrl: string;
  objectTitle: string | null;
  stateCategory: LoopClosingStateCategory;
  /** The open-ask phrase that fired, so a log line says exactly why. */
  marker: string;
}

/**
 * Resolve every work object the composed briefing names and report each place
 * the prose asks the user to act on a closed one.
 *
 * Two closure sources, and both are positive facts:
 *   1. `closedLoops` — what this run's gather already proved closed.
 *   2. A live `integration_objects` read for every other object the prose names.
 *      This is how a `get_day_shape.shipped` object is covered: it shipped
 *      because its row says `resolved`, and that row is what the guard reads.
 */
export async function auditComposedBriefing(args: {
  userId: string;
  composed: ComposedBriefingBody;
  closedLoops: readonly BriefingClosedLoop[];
}): Promise<OpenAskViolation[]> {
  const named = collectGithubPullRequestUrls(fullText(args.composed));

  if (named.length === 0) return [];

  const closedByUrl = new Map<string, ClosedObjectFact>();

  for (const loop of args.closedLoops) {
    const url = loop.objectUrl ? canonicalizeGithubPullRequestUrl({ url: loop.objectUrl }) : null;

    if (!url || !named.includes(url)) continue;
    closedByUrl.set(url, {
      url,
      stateCategory: loop.stateCategory,
      title: loop.objectTitle,
    });
  }

  await Promise.all(
    named
      .filter((url) => !closedByUrl.has(url))
      .map(async (url) => {
        const ref = await objectStateStore.resolveByKey(
          args.userId,
          "github",
          "pull_request_url",
          url,
        );

        if (!ref) return; // no row → the object is not proved closed
        const state = await objectStateStore.getState(args.userId, ref);

        if (!state || !isLoopClosingCategory(state.stateCategory)) return;
        closedByUrl.set(url, {
          url,
          stateCategory: state.stateCategory,
          title: state.title,
        });
      }),
  );

  if (closedByUrl.size === 0) return [];

  return findOpenAskViolations({ composed: args.composed, named, closedByUrl });
}

/**
 * The pure detector. Split each composed field into sentences, bind each
 * sentence to the objects it names, and report a sentence that both names a
 * closed object and carries an open-ask phrase.
 *
 * `named` is the ordered list of objects the WHOLE briefing names by URL. It
 * exists so a bare `#51` can bind: the subject and the plain-text body carry no
 * markdown link, so the number is the only reference they have. A bare number
 * binds only when exactly one object in this same briefing has that pull-request
 * number, which keeps the binding deterministic and local.
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
      const marker = findOpenAskMarker(sentence.text);

      if (!marker) continue;

      for (const url of objectsBoundTo(sentence.text, byNumber)) {
        const closed = args.closedByUrl.get(url);

        if (!closed) continue;
        violations.push({
          field,
          sentence: sentence.text.trim(),
          objectUrl: closed.url,
          objectTitle: closed.title,
          stateCategory: closed.stateCategory,
          marker,
        });
      }
    }
  }

  return violations;
}

/**
 * Drop every violating sentence from the two body fields, preserving the
 * surrounding paragraph shape.
 *
 * Returns `null` when the draft cannot be downgraded — a violating subject (the
 * headline is one beat and there is nothing left to keep), or a body that loses
 * all of its prose. The caller then fails the compose. Dropping a sentence is a
 * downgrade; writing a replacement would be an assertion, which this guard is
 * not allowed to make.
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

/** One log/prompt line per violation, for the re-prompt and the ops log. */
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
 * Phrases that frame an object as work still owed by the user. Each entry is a
 * multi-word phrase on purpose: the bare word "review" appears in honest recap
 * prose ("the review comments landed"), so matching it would block a correct
 * draft. Lower-case; the haystack is lower-cased before the scan.
 */
const OPEN_ASK_MARKERS = [
  "action needed",
  "approve it",
  "awaiting review",
  "awaiting your",
  "blocked on you",
  "blocked on your",
  "flagged for your review",
  "give it a look",
  "have a look",
  "merge it",
  "most pressing",
  "needs a decision",
  "needs a look",
  "needs action",
  "needs review",
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
 * A negated marker is not an ask — "nothing needs your review there" states the
 * opposite of what the phrase alone reads as. Only the text immediately before
 * the phrase is inspected, so this cannot reach across a clause and excuse a
 * real ask.
 */
const NEGATION_BEFORE_RE = /(?:\b(?:no|not|nothing|none|never|nobody)\b|n't)[\s,]*$/;

const NEGATION_LOOKBACK = 24;

function findOpenAskMarker(sentence: string): string | null {
  const haystack = sentence.toLowerCase();

  for (const marker of OPEN_ASK_MARKERS) {
    let from = 0;

    for (;;) {
      const at = haystack.indexOf(marker, from);

      if (at === -1) break;
      const before = haystack.slice(Math.max(0, at - NEGATION_LOOKBACK), at);

      if (!NEGATION_BEFORE_RE.test(before)) return marker;
      from = at + marker.length;
    }
  }

  return null;
}

/**
 * Pull-request number → the single object that carries it, when the briefing
 * names exactly one. A number two objects share stays out of the map, so an
 * ambiguous `#51` binds to nothing and blocks nothing.
 */
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
 * Split a composed field into independently-droppable spans: sentences, blank-line
 * paragraphs, and markdown list items. A bullet carries no end punctuation, so
 * punctuation alone fuses a whole list (plus the sign-off) into one span — one
 * violating bullet would then delete every sibling and still ship the greeting
 * (#1082 B1). A lone `\n` inside a paragraph does NOT split, so a soft-wrapped
 * sentence keeps its marker and its object reference in the same span.
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
 * Remove whole sentences by span, then repair the whitespace the removal left
 * behind. Blank lines survive, so a greeting line and a sign-off keep their own
 * paragraphs.
 */
function dropSentences(text: string, sentences: ReadonlySet<string>): string {
  if (sentences.size === 0) return text;

  const spans = splitSentences(text);
  let out = "";

  for (const [index, span] of spans.entries()) {
    if (sentences.has(span.text.trim())) continue;
    // Carry the separator that FOLLOWED this sentence, so the blank line
    // between a greeting and the paragraph survives. A dropped sentence takes
    // its own separator with it, which is what closes the gap.
    const next = spans[index + 1];

    out += span.text + (next ? text.slice(span.end, next.start) : text.slice(span.end));
  }

  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fullText(composed: ComposedBriefingBody): string {
  return `${composed.subject}\n${composed.bodyText}\n${composed.bodyMarkdown}`;
}
