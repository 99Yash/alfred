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
 * What a pull request's body is missing, or why it could not be judged.
 *
 * Three refusals rather than an empty list, because a checker that cannot see the body
 * and a checker that found the body acceptable look identical from the outside:
 *
 *   - `missing` when there is no body at all;
 *   - `unreadable` when `gh` failed, so the answer is not "this PR complies";
 *   - `thin` when the body is too short to hold four claims.
 *
 * @param {{title: string|null, body: string|null, readError?: string|null}} pr
 * @returns {{ok: boolean, missing: string[], reason: string|null}}
 */
export function prBodyFailures({ title, body, readError = null }) {
  if (readError !== null && readError !== "") {
    return {
      ok: false,
      missing: [],
      reason: `the pull request's body could not be read (${readError}), so this check would pass over a body nobody examined.`,
    };
  }

  if (body === null || body.trim() === "") {
    return {
      ok: false,
      missing: [...REQUIRED_SECTIONS],
      reason: `${title ?? "the pull request"} has no body at all.`,
    };
  }

  const missing = REQUIRED_SECTIONS.filter((section) => !statesSection(body, section));

  if (missing.length > 0) {
    return { ok: false, missing, reason: null };
  }

  const lines = body.split("\n").filter((line) => !isHeading(line));

  if (lines.length < MIN_BODY_LINES) {
    return {
      ok: false,
      missing: [],
      reason: `its body carries all four headings but only ${lines.length} line(s) of prose, which cannot be four written claims however they are formatted. A floor of ${MIN_BODY_LINES} is a measured gap between the observed bodies, not a word count.`,
    };
  }

  return { ok: true, missing: [], reason: null };
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
