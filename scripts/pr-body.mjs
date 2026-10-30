// The grammar and the rule for the pull-request body check.
//
// `CLAUDE.md` asks for a body a reviewer who knows the Alfred product but not the
// changed flow can read, in four named sections. That is a rule about a document no
// linter opens, so nothing enforced it: measured across the 31 PRs merged before this
// rule existed, 27 carried all four sections and 3 carried none of them — including a
// 3041-line change whose title was `fix`. A body that says nothing is not a style
// nit; it is the artifact the review agent is pointed at when it needs to know what a
// diff is claiming.
//
// Matching is deliberately forgiving about FORM and strict about PRESENCE. A heading
// written `### Why this change is needed`, `**Why this change is needed**` or
// `Why this change is needed:` all count, because a contributor who wrote the section
// did the work and a heading style is not what this rule is about. What it refuses is
// a body missing a section, and a body too short to be four real ones.

/**
 * The four sections `CLAUDE.md` names, in the order it lists them.
 *
 * Order is NOT enforced. The rule asks that each claim be findable, not that four
 * headings appear in one sequence; a PR that argues its case in a different order is
 * still readable.
 */
export const REQUIRED_SECTIONS = [
  "Where this change sits",
  "Why this change is needed",
  "What this change does",
  "Preserved behavior",
];

/**
 * Below this many non-blank, non-heading lines, a body cannot be four written claims
 * however it is formatted.
 *
 * A measured floor rather than a principled one. The observed bodies that carry all
 * four sections run from 8 such lines upward, and the ones missing them sit at 0-2, so
 * the threshold sits in the gap. It counts LINES rather than characters because a
 * heading can be long and a section can be short.
 */
export const MIN_BODY_LINES = 4;

/**
 * A heading is a line that is mostly markup, not a line of prose.
 *
 * Four renderings are accepted, because `CLAUDE.md` writes the sections as bare names
 * and a contributor may render them any of these ways, and a gate that rejects a
 * correct body teaches the wrong shape:
 *
 *   - `### Where this change sits` — an ATX heading;
 *   - `**Where this change sits**` — a bolded line;
 *   - `Where this change sits:` — the bare name with a trailing colon;
 *   - `> Where this change sits` — inside a blockquote, which is how these briefs quote.
 *
 * A line that merely NAMES a section inside a sentence is not a heading and does not
 * count; that is the whole reason this is a predicate rather than a substring search.
 */
function isHeading(line) {
  // Strip the blockquote and list markers a quoted brief leaves on its headings, and
  // treat what remains as the candidate heading text.
  const trimmed = line
    .trim()
    .replace(/^(?:>\s*)+/u, "")
    .replace(/^(?:[-*+]|\d+\.)\s+/u, "");

  if (trimmed.length === 0) return true;

  if (/^#{1,6}\s/u.test(trimmed)) return true;

  if (/^[*_]{1,2}[^*_]+[*_]{1,2}:?$/u.test(trimmed)) return true;

  // The bare name with a trailing colon. Anchored on the WHOLE line so a sentence that
  // happens to end in a section name cannot pass as one.
  return /^[*_]{0,2}[A-Z][^*_]*:$/u.test(trimmed);
}

/**
 * Does this LINE state the claim the section is named for?
 *
 * The single-line predicate, exported so the fixtures can assert it directly — a rename
 * of the heading matcher would otherwise leave every other case silently vacuous.
 *
 * Compared on the section name alone, not on a heading regex, so every Markdown form of
 * the same heading matches: wrapped in `###`, in `**`, suffixed with a colon, or
 * indented inside a blockquote. A line that merely MENTIONS the name in prose does not
 * count — `isHeading` is what separates the two.
 *
 * @param {string} line
 * @param {string} section
 * @returns {boolean}
 */
export function statesCondition(line, section) {
  if (!isHeading(line)) return false;

  return line.toLowerCase().includes(section.toLowerCase());
}

/**
 * Does this body state the claim the section is named for?
 *
 * @param {string} body
 * @param {string} section
 * @returns {boolean}
 */
export function statesSection(body, section) {
  return body.split("\n").some((line) => statesCondition(line, section));
}

/**
 * One issue reference: `#12`, or `owner/repo#12` across repositories.
 */
const ISSUE_REF = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+`;

/**
 * A closing keyword followed by a LIST of issues: `Closes #1, #2`, `Fixes #3 and #4`,
 * `resolved: #5, #6, and #7`.
 *
 * GitHub links only the first issue in such a list to the pull request, so a merge
 * closes #1 and leaves the others open with no warning. The keyword must be repeated
 * per issue (`Closes #1, closes #2`). That form does not match here: after the comma
 * comes a keyword, not a `#`.
 */
const CLOSING_LIST_RE = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${ISSUE_REF}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)${ISSUE_REF})+`,
  "gi",
);

/**
 * Fenced blocks and inline code spans. GitHub does not read an issue reference inside
 * code, so a body that QUOTES the wrong form (as this rule's own PR does) closes nothing.
 */
const CODE_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$|(`+)[^`]*?\2/gm;

/**
 * Why the body's closing keywords would leave issues open, or null when they would not.
 *
 * Exported so the fixtures can drive it without a full four-section body.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function closingListFailure(body) {
  const prose = body.replace(CODE_RE, " ");
  const lists = [...prose.matchAll(CLOSING_LIST_RE)].map((match) => `\`${match[0]}\``);

  if (lists.length === 0) return null;

  return `${lists.join(", ")} closes only the first issue: GitHub reads one closing keyword per issue. Repeat the keyword for each issue, as in \`Closes #1, closes #2\`.`;
}

/**
 * The longest prose sentence a body may carry. `CLAUDE.md` asks for ASD-STE100, whose
 * limit for a descriptive sentence is 25 words.
 *
 * Measured across the 120 PRs merged before this rule existed: 72 carried at least one
 * longer sentence, 163 in all. A review of #1571 found a paragraph of five passive
 * sentences of 34 to 47 words, one round after the author reported it rewritten. A
 * reviewer cannot count words reliably; this check can.
 */
export const MAX_SENTENCE_WORDS = 25;

/** A fence line opens or closes a code block: three or more backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/u;

/** A list item starts a new sentence. The marker is not a word. */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u;

/**
 * Lines that carry no prose sentence: an ATX heading, a line that is all bold or
 * italic (a heading written as emphasis), a table row, a blockquote, and a bare HTML
 * tag line such as `<details>`.
 */
function isNonProseLine(line) {
  const trimmed = line.trim();

  return (
    /^#{1,6}\s/u.test(trimmed) ||
    /^[*_]{1,2}[^*_]+[*_]{1,2}:?$/u.test(trimmed) ||
    trimmed.startsWith("|") ||
    trimmed.startsWith(">") ||
    /^<\/?[a-z][^>]*>$/iu.test(trimmed)
  );
}

/**
 * The prose paragraphs and list items of a body, each with the 1-based line it starts
 * on. Fenced code, HTML comments, headings, tables and blockquotes are left out,
 * because none of them is a sentence a reader parses as prose. Hard-wrapped lines join
 * into the paragraph or list item they continue.
 *
 * @param {string} body
 * @returns {{line: number, text: string}[]}
 */
function proseBlocks(body) {
  // Blank out each HTML comment but keep its newlines, so line numbers stay true.
  const lines = body
    .replace(/\r\n?/gu, "\n")
    .replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .split("\n");

  const blocks = [];
  // True while the next prose line continues the last block.
  let open = false;
  // The marker of the fence the scan is inside, or "" outside a fence.
  let fence = "";

  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE_RE.exec(line);

    if (fence !== "") {
      if (fenceMatch !== null && fenceMatch[1].startsWith(fence)) fence = "";
      continue;
    }

    if (fenceMatch !== null) {
      open = false;
      fence = fenceMatch[1];
      continue;
    }

    if (line.trim() === "" || isNonProseLine(line)) {
      open = false;
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    const last = blocks.at(-1);

    if (item === null && open && last !== undefined) {
      last.text += ` ${line.trim()}`;
      continue;
    }

    blocks.push({
      line: index + 1,
      text: item === null ? line.trim() : line.slice(item[0].length),
    });
    open = true;
  }

  return blocks;
}

/**
 * The text a reader counts as words. An inline code span, a URL and an image are one
 * word each, whatever is inside them; a link counts as its visible text.
 */
function readableText(text) {
  return text
    .replace(/(`+)[\s\S]*?\1/gu, "CODE")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "IMAGE")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<https?:\/\/[^>]*>/gu, "URL")
    .replace(/https?:\/\/\S+/gu, "URL")
    .replace(/<\/?[a-z][^>]*>/giu, " ");
}

/**
 * A token ends a sentence when it ends in `.`, `?`, `!` or `:`, after any closing
 * quote, bracket or emphasis mark. A colon counts because it closes a lead-in such as
 * `Fix:` or `Intended changes:`. A semicolon does not: it joins two clauses into one
 * sentence, and that join is what makes a sentence long.
 */
const SENTENCE_END_RE = /[.?!:]["'”’)\]*_]*$/u;

/** A token is a word when it holds a letter or a digit. A dash or an arrow is not. */
const WORD_RE = /[\p{L}\p{N}]/u;

/**
 * Each prose sentence longer than `MAX_SENTENCE_WORDS`, with the line it starts on.
 *
 * Exported so the fixtures can drive it without a full four-section body.
 *
 * @param {string} body
 * @returns {{line: number, words: number, sentence: string}[]}
 */
export function longSentences(body) {
  const found = [];

  for (const block of proseBlocks(body)) {
    let words = [];

    const flush = () => {
      if (words.length > MAX_SENTENCE_WORDS) {
        found.push({
          line: block.line,
          words: words.length,
          sentence: words.join(" "),
        });
      }

      words = [];
    };

    for (const token of readableText(block.text).split(/\s+/u)) {
      if (WORD_RE.test(token)) words.push(token);

      if (SENTENCE_END_RE.test(token)) flush();
    }

    flush();
  }

  return found;
}

/**
 * Review-process words a reader outside the review cannot decode.
 *
 * Each entry was found in a merged body: 69 of the 120 PRs merged before this rule
 * existed carried at least one. A body that says `Round 1 revise`, `Revise r1`,
 * `item 36` or `Net: −2` points at review notes that live in a gitignored folder, so
 * the reviewer the body is written for cannot read them. `as on main` compares to a
 * base that the merge itself moves; write `as before`. Words inside a code span are
 * not checked, so a change to the review tooling itself can still name its terms as
 * identifiers.
 *
 * Product words that share a spelling stay legal: `revise` as a verb (`the user
 * approves, revises, or ends the run`) and single-digit `item 4` of an ADR list.
 * `campaign` and `vocabulary ledger` stay legal too: each names a tracked thing a
 * reviewer can open (`.claude/skills/campaign/`, the ledger section of
 * `docs/reference/structural-review.md`), and a PR that changes either must name it.
 */
export const PROCESS_WORDS = [
  { label: "a review round number", pattern: /\bround[ -]?\d+\b/giu },
  { label: "a review round tag", pattern: /(?<![\w-])r\d(?![\w-])/gu },
  {
    label: "a revise pass",
    pattern: /\b(?:(?:the|this|that|each|later|r\d|round[ -]?\d+)\s+revises?|revise\s+r\d)\b/giu,
  },
  { label: "a review item number", pattern: /\bitems? \d{2,3}\b/giu },
  { label: "a review verdict", pattern: /\bmust-fix(?:es)?\b/giu },
  { label: "a ledger total", pattern: /\bNet:?\s*[*_]{0,2}\s*[−+-]?\s*\d/gu },
  { label: "a comparison to a moving base", pattern: /\bas on main\b/giu },
];

/**
 * Each review-process word in the body, outside code.
 *
 * Exported so the fixtures can drive it without a full four-section body.
 *
 * @param {string} body
 * @returns {{label: string, text: string}[]}
 */
export function processWords(body) {
  // `main` in a code span is still the moving base, so it stays prose. A URL or a link
  // target is an address, not a word the reader parses.
  const prose = body
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/`main`/gu, "main")
    .replace(CODE_RE, " ")
    .replace(/\]\([^)]*\)/gu, "]")
    .replace(/https?:\/\/\S+/gu, " ");

  return PROCESS_WORDS.flatMap(({ label, pattern }) =>
    [...prose.matchAll(pattern)].map((match) => ({ label, text: match[0] })),
  );
}

/**
 * Why the body's prose fails the ASD-STE100 limits this check can count, or null.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function proseFailure(body) {
  const reasons = [];
  const long = longSentences(body);
  const words = processWords(body);

  if (long.length > 0) {
    const listed = long
      .map(
        ({ line, words: count, sentence }) =>
          `  line ${line}: ${count} words: "${sentence.split(" ").slice(0, 8).join(" ")} …"`,
      )
      .join("\n");

    reasons.push(
      `${long.length} sentence(s) have more than ${MAX_SENTENCE_WORDS} words. ASD-STE100 allows ${MAX_SENTENCE_WORDS} words in a description. Split each one into short active sentences:\n${listed}`,
    );
  }

  if (words.length > 0) {
    const listed = words.map(({ label, text }) => `  \`${text}\` (${label})`).join("\n");

    reasons.push(
      `The body uses review-process words that a reviewer outside the review cannot decode:\n${listed}\nState the fact itself (the test run, the name count, the follow-up issue). Put a tool's own term in a code span.`,
    );
  }

  return reasons.length === 0 ? null : reasons.join("\n\n");
}

/**
 * What a pull request's body is missing, or why it could not be judged.
 *
 * Three refusals rather than an empty list, because a checker that cannot see the body
 * and a checker that found the body acceptable look identical from the outside:
 *
 *   - `missing` when there is no body at all;
 *   - `unreadable` when `gh` failed, so the answer is not "this PR complies";
 *   - `thin` when the body is too short to hold four claims.
 *
 * A body that lists several issues after one closing keyword also fails, with that
 * reason, because the merge would close only the first. A body whose prose has a
 * sentence over `MAX_SENTENCE_WORDS` words, or a word from `PROCESS_WORDS`, fails last,
 * with the lines to fix.
 *
 * `kind` names the refusal, so the consumer adds the four-sections note only where a
 * section is the fault.
 *
 * @param {{title: string|null, body: string|null, readError?: string|null}} pr
 * @returns {{ok: boolean, kind: "unreadable"|"missing"|"thin"|"closing"|"prose"|null, missing: string[], reason: string|null}}
 */
export function prBodyFailures({ title, body, readError = null }) {
  if (readError !== null && readError !== "") {
    return {
      ok: false,
      kind: "unreadable",
      missing: [],
      reason: `the pull request's body could not be read (${readError}), so this check would pass over a body nobody examined.`,
    };
  }

  if (body === null || body.trim() === "") {
    return {
      ok: false,
      kind: "missing",
      missing: [...REQUIRED_SECTIONS],
      reason: `${title ?? "the pull request"} has no body at all.`,
    };
  }

  const missing = REQUIRED_SECTIONS.filter((section) => !statesSection(body, section));
  const closing = closingListFailure(body);

  if (missing.length > 0) {
    return { ok: false, kind: "missing", missing, reason: closing };
  }

  const lines = body.split("\n").filter((line) => !isHeading(line));

  if (lines.length < MIN_BODY_LINES) {
    return {
      ok: false,
      kind: "thin",
      missing: [],
      reason: `its body carries all four headings but only ${lines.length} line(s) of prose, which cannot be four written claims however they are formatted. A floor of ${MIN_BODY_LINES} is a measured gap between the observed bodies, not a word count.`,
    };
  }

  if (closing !== null) return { ok: false, kind: "closing", missing: [], reason: closing };

  const prose = proseFailure(body);

  if (prose !== null) return { ok: false, kind: "prose", missing: [], reason: prose };

  return { ok: true, kind: null, missing: [], reason: null };
}

/**
 * The `gh pr view` arguments for one ref, as both `spawnSync` and the diagnostic string
 * need them.
 *
 * `ref` is passed through rather than resolved here, so the same expression serves a
 * branch name (`HEAD`), a PR number (what CI passes), and anything else `gh` accepts —
 * and so a ref `gh` rejects produces `gh`'s own error rather than one invented here.
 *
 * @param {string} ref
 * @returns {string[]}
 */
export function viewArguments(ref) {
  return ["pr", "view", ref, "--json", "number,title,body,headRefName,state"];
}
