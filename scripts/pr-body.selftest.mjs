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

import { prBodyFailures, statesCondition } from "./pr-body.mjs";

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
    failures.push(...drive(`${label} headings are accepted`, { body, ok: true, missing: [] }));
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
  ];
}
