// Fixtures for the smell catalog grammar in ./smells.mjs.
//
// The catalog is the place where a review finding turns into a gate, so the rule
// that matters most is the promotion rule: a smell found in two PRs, with a rung
// that a check can state, must get a decision. Each case below plants one
// violation in a valid smell and asserts that the message names it. A case never
// asserts that a valid smell is silent and stops there; the base case proves the
// fixture is valid, so each mutation is the only reason for its failure.

import { addHit, parseSmell, smellFailures } from "./smells.mjs";

const ENFORCED = "| `alfred/log-caught-error-under-err` | all | Rejects … |";

/** A valid `review` smell with one hit. */
function base() {
  return [
    "---",
    "id: probe-smell",
    "section: Backend",
    "status: review",
    "rung: ast",
    "feasibility: medium",
    "---",
    "",
    "# Log a caught error only under `err`.",
    "",
    "Why: only `err` goes through the serializer.",
    "",
    "## Bad",
    "",
    "```ts",
    'logger.warn({ error }, "failed");',
    "```",
    "",
    "## Good",
    "",
    "```ts",
    'logger.warn({ err }, "failed");',
    "```",
    "",
    "## Mechanism",
    "",
    "AST: a catch binding under another logger key.",
    "",
    "## Hits",
    "",
    "- #1528 push.ts: `reason: err.message`.",
    "",
  ].join("\n");
}

function failuresOf(text, id = "probe-smell") {
  return smellFailures(parseSmell(`docs/reference/smells/${id}.md`, text), {
    id,
    enforcedText: ENFORCED,
  });
}

/** @type {[string, (text: string) => string, string][]} */
const CASES = [
  [
    "a second PR hit on a checkable review smell makes a decision due",
    (text) => addHit(text, 1575, "sentry-routes.ts: `cause: err.message`."),
    "reviews found this smell in 2 PRs",
  ],
  [
    "a candidate needs an issue",
    (text) => text.replace("status: review", "status: candidate"),
    "needs `issue: #<n>`",
  ],
  [
    "a gated smell needs a rule that a gate runs",
    (text) =>
      text
        .replace("status: review", "status: gated")
        .replace("feasibility: medium", "rule: alfred/not-a-rule"),
    "is not in docs/reference/enforced-rules.md",
  ],
  [
    "a gated smell keeps no feasibility",
    (text) =>
      text
        .replace("status: review", "status: gated")
        .replace("feasibility: medium", "rule: alfred/log-caught-error-under-err")
        .replace("rung: ast", "rung: ast\nfeasibility: low"),
    "`feasibility` applies only",
  ],
  [
    "a stays-review smell has no rung",
    (text) =>
      text.replace("status: review", "status: stays-review").replace("feasibility: medium\n", ""),
    "a `stays-review` smell has `rung: none`",
  ],
  [
    "rung none needs stays-review",
    (text) => text.replace("rung: ast", "rung: none"),
    "set `status: stays-review`",
  ],
  [
    "the id matches the file name",
    (text) => text.replace("id: probe-smell", "id: other-smell"),
    "must equal the file name",
  ],
  [
    "an unknown section",
    (text) => text.replace("section: Backend", "section: Misc"),
    "`section` must be one of",
  ],
  [
    "an unknown key",
    (text) => text.replace("feasibility: medium", "feasibility: medium\nowner: me"),
    "unknown frontmatter key `owner`",
  ],
  [
    "keys out of order",
    (text) => text.replace("status: review\nrung: ast", "rung: ast\nstatus: review"),
    "write the frontmatter keys in the order",
  ],
  [
    "a missing Bad example",
    (text) => text.replace("## Bad", "## Worse"),
    "section `## Bad` is missing",
  ],
  [
    "an empty Good example",
    (text) => text.replace(/## Good\n[\s\S]*?## Mechanism/, "## Good\n\n## Mechanism"),
    "section `## Good` is empty",
  ],
  [
    "a missing Why",
    (text) => text.replace("Why: only", "Because only"),
    "needs a `Why: ` paragraph",
  ],
  ["a hit without a PR", (text) => `${text}- push.ts: no PR\n`, "a hit must read"],
  [
    "a placeholder left in",
    (text) => text.replace("AST: a catch", "TODO(smell): a catch"),
    "replace each `TODO(smell)`",
  ],
];

export function smellsSelfTestFailures() {
  const failures = [];
  const clean = failuresOf(base());

  if (clean.length > 0) failures.push(`the base fixture must be valid: ${clean.join("; ")}`);

  for (const [label, mutate, expected] of CASES) {
    const found = failuresOf(mutate(base()));

    if (!found.some((failure) => failure.includes(expected))) {
      failures.push(
        `${label}: expected a failure with ${JSON.stringify(expected)}, received ${JSON.stringify(found)}`,
      );
    }
  }

  const twice = addHit(base(), 1575, "second.ts: finding.");

  try {
    addHit(twice, 1575, "second.ts: finding.");
    failures.push("addHit: a repeated hit line must throw");
  } catch {
    // The refusal is the behavior under test.
  }

  if (!parseSmell("x.md", twice).hits.some((hit) => hit.pr === 1575)) {
    failures.push("addHit: the new hit must parse under `## Hits`");
  }

  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = smellsSelfTestFailures();

  if (failures.length > 0) {
    console.error("smells self-test failed:\n");

    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  console.log("smells self-test: every planted violation is reported.");
}
