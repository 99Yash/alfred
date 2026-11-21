/**
 * Deterministic scores for an answer that depends on the current time (ADR-0130 decision 7).
 * Each score reads three facts from the text: which event the answer names as ahead, the
 * direction of each wait ("in 40 min", not "40 min ago"), and the length of the wait.
 *
 * The text splits into sentences, and each sentence into clauses at commas and conjunctions. A
 * clause that names an event and has a past word ("ended", "ago", "already") marks the event as
 * past. A negated past word ("not over yet", "nothing has passed") marks it as ahead.
 */

/** A wait in the answer may differ from the true wait by this many minutes. */
const WAIT_TOLERANCE_MIN = 5;

/** The answer to "how long until my next meeting?": one event, and the wait until it starts. */
interface NextExpectation {
  kind: "next";
  next: RegExp;
  waitMinutes: number;
  /** Every other event of the day. None may show as next. */
  others: RegExp[];
  /** The events that already ended. None may show as ahead. */
  past: RegExp[];
}

/** The answer to "what is left on my calendar today?". */
interface LeftExpectation {
  kind: "left";
  ahead: RegExp[];
  past: RegExp[];
}

/** A question that does not depend on the current time, with one fact in the answer. */
interface FactExpectation {
  kind: "fact";
  answer: RegExp;
}

export type TimeAnswerExpectation = NextExpectation | LeftExpectation | FactExpectation;

const PAST =
  /\b(?:ago|already|earlier|done|passed|finished|ended|completed|wrapped up|behind you|was|were|had)\b|\bover\b(?!\s+(?:\d|an?\b|half\b|the\b))/i;

const NEGATED_PAST =
  /(?:\bnot\b|n't\b|\bnever\b|\bnothing\b|\bnone\b)[^,;.]{0,25}?\b(?:over|ended|passed|done|finished|happened|completed|started)\b|\bnot yet\b|\byet to\b/i;

const NEXT_WORD = /\bnext\b|\bup first\b|\bfirst up\b/i;

/** A start in the next few minutes, written without a number. Counts only for a short wait. */
const SOON =
  /\b(?:about to (?:start|begin)|starting (?:now|soon|shortly)|starts? (?:now|soon|shortly|any minute)|in a few minutes|in a moment|right now)\b/i;

const SOON_MAX_MINUTES = 10;

const WORD_NUMBERS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
} satisfies Record<string, number>;

function isNumberWord(word: string): word is keyof typeof WORD_NUMBERS {
  return Object.hasOwn(WORD_NUMBERS, word);
}

const HOURS =
  /(half an?|\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:hours?|hrs?|h)(?![a-z])(?:\s*(?:and\s+)?(?:(\d+)\s*(?:minutes?|mins?|m)(?![a-z])|(a half)))?/gi;

const MINUTES = /(\d+)\s*(?:minutes?|mins?|m)(?![a-z])/gi;

const AGO_AFTER = /^\s*(?:ago|earlier|back)\b/i;

interface Wait {
  minutes: number;
  ago: boolean;
}

function hourCount(word: string): number {
  const lower = word.toLowerCase();

  if (lower.startsWith("half")) return 0.5;

  return isNumberWord(lower) ? WORD_NUMBERS[lower] : Number(lower);
}

/** Each wait in one sentence: `4 h 8 min`, `an hour and a half`, `40 minutes ago`. */
function waitsIn(sentence: string): Wait[] {
  const waits: Wait[] = [];
  let rest = sentence;

  for (const match of sentence.matchAll(HOURS)) {
    const hours = hourCount(match[1] ?? "0");
    const extra = match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? 30 : 0;
    const after = sentence.slice(match.index + match[0].length);

    waits.push({ minutes: Math.round(hours * 60 + extra), ago: AGO_AFTER.test(after) });
    rest = rest.replace(match[0], " ".repeat(match[0].length));
  }

  for (const match of rest.matchAll(MINUTES)) {
    const after = rest.slice(match.index + match[0].length);

    waits.push({ minutes: Number(match[1]), ago: AGO_AFTER.test(after) });
  }

  return waits;
}

/** `2 p.m.` keeps its dots out of the sentence split. */
function sentencesOf(text: string): string[] {
  return text
    .replace(/\b([ap])\.m\./gi, "$1m")
    .split(/(?<!\d)\.(?!\d)|[!?;\n]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function clausesOf(sentence: string): string[] {
  return sentence
    .split(/,|\s+(?=(?:but|then|while|whereas|so|and (?:the|your|then|after))\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isPastClause(clause: string): boolean {
  return PAST.test(clause) && !NEGATED_PAST.test(clause);
}

/** True when some clause names the event and does not say that it is past. */
function shownAhead(clauses: string[], event: RegExp): boolean {
  return clauses.some((clause) => event.test(clause) && !isPastClause(clause));
}

function hasWaitNear(sentence: string, minutes: number): boolean {
  if (minutes <= SOON_MAX_MINUTES && SOON.test(sentence)) return true;

  return waitsIn(sentence).some(
    (wait) => !wait.ago && Math.abs(wait.minutes - minutes) <= WAIT_TOLERANCE_MIN,
  );
}

/** The past events that the answer shows as ahead. */
function pastShownAhead(clauses: string[], past: RegExp[]): RegExp[] {
  return past.filter((event) => shownAhead(clauses, event));
}

/** Null when the answer names the right next event, as ahead, with the right wait. Else the fault. */
function scoreNext(text: string, expected: NextExpectation): string | null {
  const sentences = sentencesOf(text);
  const clauses = sentences.flatMap(clausesOf);

  if (!shownAhead(clauses, expected.next)) return `does not show ${String(expected.next)} as ahead`;

  const pastAhead = pastShownAhead(clauses, expected.past);

  if (pastAhead.length > 0) return `shows past ${pastAhead.map(String).join(", ")} as ahead`;

  const wrongNext = clauses.find(
    (clause) =>
      NEXT_WORD.test(clause) &&
      !expected.next.test(clause) &&
      expected.others.some((event) => event.test(clause)),
  );

  if (wrongNext !== undefined) return `names another event as next: "${wrongNext}"`;

  const allEvents = [expected.next, ...expected.others];

  // The wait is in the sentence that names the event, or in the next sentence if it names none.
  const waitFound = sentences.some((sentence, index) => {
    if (!expected.next.test(sentence)) return false;

    if (!clausesOf(sentence).some((c) => expected.next.test(c) && !isPastClause(c))) return false;

    if (hasWaitNear(sentence, expected.waitMinutes)) return true;
    const following = sentences[index + 1];

    return (
      following !== undefined &&
      !allEvents.some((event) => event.test(following)) &&
      hasWaitNear(following, expected.waitMinutes)
    );
  });

  return waitFound
    ? null
    : `no wait of ${expected.waitMinutes}±${WAIT_TOLERANCE_MIN} min ahead for ${String(expected.next)}`;
}

/** Null when every event ahead shows as ahead and no past event does. Else the fault. */
function scoreLeft(text: string, expected: LeftExpectation): string | null {
  const clauses = sentencesOf(text).flatMap(clausesOf);
  const missing = expected.ahead.filter((event) => !shownAhead(clauses, event));

  if (missing.length > 0) return `does not show ${missing.map(String).join(", ")} as ahead`;

  const pastAhead = pastShownAhead(clauses, expected.past);

  return pastAhead.length > 0 ? `shows past ${pastAhead.map(String).join(", ")} as ahead` : null;
}

export function scoreTimeAnswer(text: string, expected: TimeAnswerExpectation): string | null {
  switch (expected.kind) {
    case "next":
      return scoreNext(text, expected);
    case "left":
      return scoreLeft(text, expected);
    case "fact":
      return expected.answer.test(text) ? null : `no ${String(expected.answer)}`;
  }
}
