// Fixtures for the pull-request body check.
//
// The subject is a document no linter opens, so the failure this rule exists to catch
// is invisible to every other gate in the repo: a body that says nothing still merges,
// still typechecks, and still leaves a reviewer with nothing but a diff. Measured across
// the 31 PRs merged before the rule existed, 3 of them carried none of the four sections.
//
// Every case asserts that a MUTATION is reported, never that a good body is silent —
// and the mutation here is always a REMOVED section, because that is the only move a
// contributor makes by accident.

import {
  closingListFailure,
  longSentences,
  prBodyFailures,
  processWords,
  statesCondition,
} from "./pr-body.mjs";

function equal(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);

  return left === right ? [] : [`${label}: expected ${right}, received ${left}`];
}

/** A body carrying every section, as a contributor who followed CLAUDE.md writes one. */
function fullBody() {
  return [
    "### Where this change sits",
    "",
    "The sync pull reads every visible row of each synced entity on every push.",
    "",
    "### Why this change is needed",
    "",
    "A thread with 400 documents re-read all of them to serve one changed row.",
    "",
    "### What this change does",
    "",
    "Each entity read is now keyed on its updated_at high-water mark.",
    "",
    "### Preserved behavior",
    "",
    "The visibility bounds and the cursor cursor are unchanged.",
  ].join("\n");
}

function dropSection(body, heading) {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.includes(heading));

  if (at === -1) throw new Error(`fixture has no ${heading} heading to remove`);

  // Drop the heading and the prose under it, up to the next heading. Removing only the
  // heading line would leave an orphan paragraph, which the rule must also catch — and
  // that is a separate case below.
  const end = lines.findIndex((line, index) => index > at && line.startsWith("### "));

  return [...lines.slice(0, at), ...(end === -1 ? [] : lines.slice(end))].join("\n");
}

function drive(label, { body, title = "feat(sync): read only the changed rows", ok, missing }) {
  const result = prBodyFailures({ title, body });
  const failures = [];

  if (result.ok !== ok) {
    failures.push(`${label}: expected ok=${ok}, received ${JSON.stringify(result)}`);
  }

  if (missing !== undefined) {
    failures.push(...equal(result.missing, missing, `${label}: missing`));
  }

  return failures;
}

/** The false-positive control: the body CLAUDE.md describes is compliant. */
function completeBodyIsAccepted() {
  return drive("a body with all four sections is accepted", {
    body: fullBody(),
    ok: true,
    missing: [],
  });
}

/**
 * The subject, per section: removing any ONE heading must redden the check, and the
 * diagnostic must name that section rather than saying only "invalid".
 */
function eachMissingSectionIsReported() {
  const failures = [];

  for (const heading of [
    "Where this change sits",
    "Why this change is needed",
    "What this change does",
    "Preserved behavior",
  ]) {
    failures.push(
      ...drive(`a body missing "${heading}" is reported`, {
        body: dropSection(fullBody(), heading),
        ok: false,
        missing: [heading],
      }),
    );
  }

  return failures;
}

/** No body at all is the loudest case, and must not read as compliance. */
function absentBodyIsReported() {
  return drive("a body that is empty is reported", {
    body: "",
    ok: false,
    missing: [
      "Where this change sits",
      "Why this change is needed",
      "What this change does",
      "Preserved behavior",
    ],
  });
}

/**
 * Four headings and no prose under them. This is the shape a stub body takes, and it is
 * the reason the rule counts prose lines and not headings: without this case a body of
 * four bare headings would pass.
 */
function headingsWithoutProseIsReported() {
  return drive("four headings with no prose is reported", {
    body: [
      "### Where this change sits",
      "### Why this change is needed",
      "### What this change does",
      "### Preserved behavior",
    ].join("\n"),
    ok: false,
    missing: [],
  });
}

/**
 * Heading style is not what this rule is about. Every rendering of the same four claims
 * must pass, or contributors will satisfy the gate with the wrong shape.
 */
function headingStylesAreAccepted() {
  const failures = [];

  const bolded = [
    "**Where this change sits**",
    "Prose about where this sits, long enough to be a claim.",
    "**Why this change is needed**",
    "Prose about the need, long enough to be a claim.",
    "**What this change does**",
    "Prose about the change, long enough to be a claim.",
    "**Preserved behavior**",
    "Prose about what is preserved, long enough to be a claim.",
  ].join("\n");

  const colonSuffixed = [
    "Where this change sits:",
    "Prose about where this sits, long enough to be a claim.",
    "Why this change is needed:",
    "Prose about the need, long enough to be a claim.",
    "What this change does:",
    "Prose about the change, long enough to be a claim.",
    "Preserved behavior:",
    "Prose about what is preserved, long enough to be a claim.",
  ].join("\n");

  const blockquoted = fullBody()
    .split("\n")
    .map((line) => (line === "" ? line : `> ${line}`))
    .join("\n");

  for (const [label, body] of [
    ["bolded", bolded],
    ["colon-suffixed", colonSuffixed],
    ["blockquote-wrapped", blockquoted],
  ]) {
    failures.push(
      ...drive(`${label} headings are accepted`, {
        body,
        ok: true,
        missing: [],
      }),
    );
  }

  return failures;
}

/**
 * `gh` failing is a REFUSAL, not a pass. A checker that reports compliance because it
 * could not ask is the fail-open shape every other check in this repo is written against.
 */
function unreadableBodyIsRefused() {
  const result = prBodyFailures({
    title: "fix",
    body: null,
    readError: "exit 1: could not resolve to a PullRequest",
  });

  if (result.ok !== false) {
    return [`an unreadable body must not read as compliant, received ${JSON.stringify(result)}`];
  }

  if (result.reason === null || !result.reason.includes("could not be read")) {
    return [`an unreadable body must say why, received ${JSON.stringify(result.reason)}`];
  }

  return [];
}

/**
 * A prose line that merely MENTIONS a section name must not satisfy it. Without this,
 * the sentence "This preserves the behavior of the old loop." inside a paragraph would
 * count as the `Preserved behavior` section and a body could pass while omitting it.
 */
function proseMentionIsNotASection() {
  const body = [
    "### Where this change sits",
    "",
    "The sync pull reads every visible row of each synced entity on every push.",
    "",
    "### Why this change is needed",
    "",
    "A thread with 400 documents re-read all of them to serve one changed row.",
    "",
    "### What this change does",
    "",
    "Each entity read is now keyed on its updated_at high-water mark. This preserves",
    "the behavior of the old loop for every caller.",
  ].join("\n");

  return drive("a prose mention is not a section", {
    body,
    ok: false,
    missing: ["Preserved behavior"],
  });
}

/**
 * The predicate this suite's other cases rest on. It is exported from the module under
 * test, so asserting it here is what stops a rename from silently making every case
 * above vacuous.
 */
function statesConditionIsWired() {
  return [
    ...equal(
      statesCondition("**What this change does**", "What this change does"),
      true,
      "a bolded heading states its section",
    ),
    ...equal(
      statesCondition("Some prose naming Preserved behavior in passing.", "Preserved behavior"),
      false,
      "prose naming a section does not state it",
    ),
  ];
}

/**
 * GitHub links only the first issue after one closing keyword, so `Closes #1, #2` merges
 * with #2 still open. Each list spelling must be refused, and the per-issue form that
 * GitHub does read must pass, so the rule cannot be satisfied by refusing every keyword.
 */
function closingKeywordListIsRefused() {
  const refused = [
    "Closes #1, #2",
    "fixes #12 and #13",
    "Resolved: #5, #6, and #7",
    "CLOSES 99Yash/alfred#1, 99Yash/alfred#2",
    "Fix #3 & #4",
    "Moves `scheduledFireTime` out. Closes #8, #9",
  ];

  const accepted = [
    "Closes #1, closes #2",
    "Fixes #12. Fixes #13.",
    "Closes #1",
    "Refs #1, #2",
    "Follows #1340, #1341 and #1342.",
    "GitHub closes only the first issue in `Closes #1, #2`.",
    "```\nCloses #1, #2\n```",
  ];

  return [
    ...refused.flatMap((line) =>
      closingListFailure(line) === null ? [`a closing list is accepted: ${line}`] : [],
    ),
    ...accepted.flatMap((line) =>
      closingListFailure(line) === null ? [] : [`a valid reference is refused: ${line}`],
    ),
    ...drive("a full body with a closing list is refused", {
      body: `${fullBody()}\n\nCloses #1, #2`,
      ok: false,
      missing: [],
    }),
    ...drive("a full body that repeats the keyword is accepted", {
      body: `${fullBody()}\n\nCloses #1, closes #2`,
      ok: true,
      missing: [],
    }),
  ];
}

/** `count` plain words, so a fixture states its length rather than spelling it. */
function words(count) {
  return Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
}

/**
 * The limit is 25 words. A sentence of 26 is reported and one of 25 is not, so the
 * boundary cannot drift by one in either direction without a red self-test.
 */
function longSentenceBoundaryIsPinned() {
  return [
    ...equal(
      longSentences(`${words(26)}.`).map((found) => found.words),
      [26],
      "a 26-word sentence is reported",
    ),
    ...equal(longSentences(`${words(25)}.`), [], "a 25-word sentence is accepted"),
    ...equal(
      longSentences(`${words(20)}. ${words(20)}.`),
      [],
      "two short sentences in one line are two sentences",
    ),
    ...equal(
      longSentences(`${words(15)}\n${words(15)}.`).map((found) => found.words),
      [30],
      "a hard-wrapped sentence is joined across lines",
    ),
    ...equal(
      longSentences(`Intro:\n\n- ${words(20)}\n- ${words(20)}`),
      [],
      "each list item is its own sentence",
    ),
    ...equal(longSentences(`${words(20)}: ${words(20)}.`), [], "a colon ends a lead-in"),
    ...equal(
      longSentences(`${words(15)}; ${words(15)}.`).map((found) => found.words),
      [30],
      "a semicolon does not end a sentence",
    ),
    ...equal(longSentences(`**Proof.** ${words(20)}.`), [], "a bold label ends at its period"),
  ];
}

/**
 * Text that is not a prose sentence must not count, or the rule would fail a body for
 * a code listing or a table. Each case is longer than the limit on purpose.
 */
function nonProseIsSkipped() {
  const long = `${words(40)}.`;

  return [
    ...equal(longSentences(`\`\`\`\n${long}\n\`\`\``), [], "fenced code is skipped"),
    ...equal(longSentences(`~~~ts\n${long}\n~~~`), [], "a tilde fence is skipped"),
    ...equal(longSentences(`| ${long} | x |`), [], "a table row is skipped"),
    ...equal(longSentences(`> ${long}`), [], "a blockquote is skipped"),
    ...equal(longSentences(`### ${long}`), [], "a heading is skipped"),
    ...equal(longSentences(`<!--\n${long}\n-->`), [], "an HTML comment is skipped"),
    ...equal(
      longSentences(`${words(20)} \`${words(10)}\` and https://example.com/${words(1)}.`),
      [],
      "a code span and a URL are one word each",
    ),
    ...equal(
      longSentences(`${words(20)} [${words(3)}](https://example.com/a-long-path).`),
      [],
      "a link counts its visible text",
    ),
  ];
}

/**
 * Each process word is refused where a merged body used it, and the product word that
 * shares its spelling is accepted, so the set cannot widen into ordinary prose.
 */
function processWordsAreRefused() {
  const refused = [
    "## Round 2 revise",
    "The round-1 review counted −1.",
    "Revise r1 verification: the suites pass.",
    "Repeated after the revise with the export.",
    "Refs: campaign type-flow item 36.",
    "A known follow-up (item 01 review r3) stays.",
    "Round 1 found 2 must-fix items.",
    "### Vocabulary ledger",
    "- Net: −4 names.",
    "Net -2.",
    "Every call site shows the same text as on main.",
    "The tests time out at 120 s, as on `main`.",
  ];

  const accepted = [
    "The user approves, revises, or ends the run.",
    "A chat turn can create, extend, or revise an artifact.",
    "This builds slice 1 of the ADR-0100 amendment (items 1 and 2).",
    "The file lives in the Cloudflare R2 bucket.",
    "The change removes 8 names and adds 6, for a net of −2.",
    "The `campaign` skill and its `revise` phase change.",
    "The broker ledger keeps one row per call.",
    "A round-trip through the parser keeps the value.",
    "See [the notes](https://example.com/campaign/r1).",
  ];

  return [
    ...refused.flatMap((line) =>
      processWords(line).length === 0 ? [`a process word is accepted: ${line}`] : [],
    ),
    ...accepted.flatMap((line) =>
      processWords(line).length === 0
        ? []
        : [`ordinary prose is refused: ${line} (${JSON.stringify(processWords(line))})`],
    ),
  ];
}

/** Both prose faults reach the verdict, not only the exported predicates. */
function proseFaultsFailTheBody() {
  return [
    ...drive("a full body with a long sentence is refused", {
      body: `${fullBody()}\n\n${words(30)}.`,
      ok: false,
      missing: [],
    }),
    ...drive("a full body with a process word is refused", {
      body: `${fullBody()}\n\nRound 1 found nothing.`,
      ok: false,
      missing: [],
    }),
    ...equal(
      prBodyFailures({ title: "x", body: `${fullBody()}\n\n${words(30)}.` }).kind,
      "prose",
      "a prose fault names its kind",
    ),
  ];
}

export function prBodySelfTestFailures() {
  return [
    ...completeBodyIsAccepted(),
    ...eachMissingSectionIsReported(),
    ...absentBodyIsReported(),
    ...headingsWithoutProseIsReported(),
    ...headingStylesAreAccepted(),
    ...unreadableBodyIsRefused(),
    ...proseMentionIsNotASection(),
    ...statesConditionIsWired(),
    ...closingKeywordListIsRefused(),
    ...longSentenceBoundaryIsPinned(),
    ...nonProseIsSkipped(),
    ...processWordsAreRefused(),
    ...proseFaultsFailTheBody(),
  ];
}
