// The smell catalog: one file per review rule in docs/reference/smells/.
//
// A smell is a code shape that review catches and no gate rejects yet. Each file
// holds the rule, the reason, a Bad and a Good example, the mechanism that could
// enforce it, and a ledger of the PRs where a review found it. A review that
// finds a smell adds a hit (`hit`). When a smell has hits in two PRs and a rung
// that a check can state, the catalog fails until someone decides: write the rule
// (`gated`), file an issue for it (`candidate`), or record why it stays review
// (`stays-review`). So review findings turn into gates by a rule, not by memory.
//
// This file is the grammar and the renderer. It writes three views, so nobody
// keeps a second table by hand:
//   - docs/reference/smells/README.md: the index of every smell.
//   - docs/reference/review-checklist.md: the smells that review still owns.
//   - the queue region of docs/reference/gate-design.md: the mechanism and the
//     status of each smell that review owns.
//
// Usage:
//   node scripts/smells.mjs                      write the three views
//   node scripts/smells.mjs --check              fail on a bad smell file or a stale view
//                                                (`pnpm check:smells` runs this after the self-test)
//   node scripts/smells.mjs hit <id> <pr> <text> add a hit, then write the views
//   node scripts/smells.mjs new <id> <section>   write a smell file to fill in
//   node scripts/smells.mjs queue                list the smells that wait for a gate

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const SMELL_DIR = "docs/reference/smells";

export const INDEX = `${SMELL_DIR}/README.md`;

export const CHECKLIST = "docs/reference/review-checklist.md";

export const GATE_DESIGN = "docs/reference/gate-design.md";

export const ENFORCED = "docs/reference/enforced-rules.md";

const QUEUE_START = "<!-- smells:queue:start -->";

const QUEUE_END = "<!-- smells:queue:end -->";

const WRITE_COMMAND = "node scripts/smells.mjs";

/** The checklist sections, in the order the checklist prints them. */
export const SECTIONS = [
  "Types",
  "Constants and ownership",
  "Backend",
  "Frontend",
  "Tests",
  "Process",
];

/**
 * - `review`: review owns it, and no decision is due yet.
 * - `candidate`: a gate is planned; `issue` names the work.
 * - `gated`: `rule` enforces it; the file stays for its examples and ledger.
 * - `stays-review`: decided; `## Mechanism` says why no check can state it.
 */
export const STATUSES = ["review", "candidate", "gated", "stays-review"];

/** The rungs of gate-design.md, plus `check` (a check script) and `none`. */
export const RUNGS = ["compiler", "type-lint", "ast", "regex", "check", "none"];

/** The rungs where a check can state the rule, so a second hit makes a decision due. */
const CHECKABLE_RUNGS = new Set(["compiler", "type-lint", "ast", "regex", "check"]);

export const FEASIBILITIES = ["high", "medium", "low"];

/** Distinct PRs with a hit, at which a checkable `review` smell needs a decision. */
export const PROMOTION_HITS = 2;

const REQUIRED_SECTIONS = ["Bad", "Good", "Mechanism", "Hits"];

const FIELD_ORDER = ["id", "section", "status", "rung", "feasibility", "rule", "issue"];

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const HIT_PATTERN = /^- #(\d+) \S/;

const PLACEHOLDER = "TODO(smell)";

/**
 * @typedef {{
 *   file: string,
 *   fields: Map<string, string>,
 *   title: string,
 *   detail: string,
 *   why: string,
 *   sections: Map<string, string>,
 *   hits: { pr: number, line: string }[],
 *   failures: string[],
 * }} Smell
 */

/**
 * Parses one smell file. The grammar is strict on purpose: a hit or a field that
 * the parser cannot read would drop out of the count with no error.
 *
 * @param {string} file repo-relative path, for messages
 * @param {string} text
 * @returns {Smell}
 */
export function parseSmell(file, text) {
  /** @type {string[]} */
  const failures = [];
  const fields = new Map();
  const lines = text.split("\n");

  if (lines[0] !== "---")
    failures.push(`${file}: the file must open with a \`---\` frontmatter line`);

  const close = lines.indexOf("---", 1);

  if (close === -1) failures.push(`${file}: the frontmatter has no closing \`---\` line`);

  for (const line of lines.slice(1, Math.max(close, 1))) {
    const match = /^([a-z]+): (\S.*)$/.exec(line);

    if (!match) {
      failures.push(`${file}: frontmatter line is not \`key: value\`: ${JSON.stringify(line)}`);
      continue;
    }

    const [, key, value] = match;

    if (!FIELD_ORDER.includes(key)) failures.push(`${file}: unknown frontmatter key \`${key}\``);

    if (fields.has(key)) failures.push(`${file}: frontmatter key \`${key}\` appears twice`);
    fields.set(key, value.trim());
  }

  const body = lines.slice(close + 1);
  const titleIndex = body.findIndex((line) => line.trim() !== "");
  const titleLine = body[titleIndex] ?? "";
  const title = titleLine.startsWith("# ") ? titleLine.slice(2).trim() : "";

  if (!title) failures.push(`${file}: the body must open with a \`# <rule>\` heading`);

  const firstSection = body.findIndex((line) => line.startsWith("## "));
  const lead = body.slice(titleIndex + 1, firstSection === -1 ? body.length : firstSection);
  const whyIndex = lead.findIndex((line) => line.startsWith("Why: "));
  const detail = paragraph(lead.slice(0, whyIndex === -1 ? lead.length : whyIndex));
  const why = whyIndex === -1 ? "" : paragraph(lead.slice(whyIndex));

  if (!why)
    failures.push(`${file}: the rule needs a \`Why: \` paragraph before the first \`##\` section`);

  /** @type {Map<string, string>} */
  const sections = new Map();
  let current = "";

  for (const line of firstSection === -1 ? [] : body.slice(firstSection)) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();

      if (sections.has(current)) failures.push(`${file}: section \`## ${current}\` appears twice`);
      sections.set(current, "");
      continue;
    }

    sections.set(current, `${sections.get(current)}${line}\n`);
  }

  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) failures.push(`${file}: section \`## ${name}\` is missing`);
    else if (name !== "Hits" && !sections.get(name)?.trim()) {
      failures.push(`${file}: section \`## ${name}\` is empty`);
    }
  }

  /** @type {{ pr: number, line: string }[]} */
  const hits = [];

  for (const line of (sections.get("Hits") ?? "").split("\n")) {
    if (line.trim() === "") continue;

    const match = HIT_PATTERN.exec(line);

    if (!match) {
      failures.push(
        `${file}: a hit must read \`- #<pr> <where>: <finding>\`: ${JSON.stringify(line)}`,
      );
      continue;
    }

    hits.push({ pr: Number(match[1]), line });
  }

  if (text.includes(PLACEHOLDER))
    failures.push(`${file}: replace each \`${PLACEHOLDER}\` placeholder`);

  return { file, fields, title, detail, why, sections, hits, failures };
}

/** @param {string[]} lines */
function paragraph(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/** @param {Smell} smell */
export function distinctPrs(smell) {
  return new Set(smell.hits.map((hit) => hit.pr)).size;
}

/**
 * The failures of one parsed smell against the catalog rules.
 *
 * @param {Smell} smell
 * @param {{ id: string, enforcedText: string }} context
 *   `id` is the file name without `.md`; `enforcedText` is the generated catalog
 *   of gate rules, which a `gated` smell must name.
 * @returns {string[]}
 */
export function smellFailures(smell, { id, enforcedText }) {
  const failures = [...smell.failures];
  const { file, fields } = smell;
  const get = (key) => fields.get(key) ?? "";
  const status = get("status");
  const rung = get("rung");

  if (get("id") !== id) failures.push(`${file}: \`id\` must equal the file name \`${id}\``);

  if (!ID_PATTERN.test(id)) failures.push(`${file}: the id must be kebab-case`);

  if (!SECTIONS.includes(get("section"))) {
    failures.push(`${file}: \`section\` must be one of ${SECTIONS.join(", ")}`);
  }

  if (!STATUSES.includes(status))
    failures.push(`${file}: \`status\` must be one of ${STATUSES.join(", ")}`);

  if (!RUNGS.includes(rung)) failures.push(`${file}: \`rung\` must be one of ${RUNGS.join(", ")}`);

  const order = [...fields.keys()].map((key) => FIELD_ORDER.indexOf(key));

  if (order.some((index, at) => at > 0 && index < order[at - 1])) {
    failures.push(`${file}: write the frontmatter keys in the order ${FIELD_ORDER.join(", ")}`);
  }

  const open = status === "review" || status === "candidate";

  if (open && !FEASIBILITIES.includes(get("feasibility"))) {
    failures.push(
      `${file}: a \`${status}\` smell needs \`feasibility\`: ${FEASIBILITIES.join(", ")}`,
    );
  }

  if (!open && fields.has("feasibility")) {
    failures.push(`${file}: \`feasibility\` applies only to a \`review\` or \`candidate\` smell`);
  }

  if (status === "candidate" && !/^#\d+$/.test(get("issue"))) {
    failures.push(`${file}: a \`candidate\` smell needs \`issue: #<n>\` for the gate work`);
  }

  if (status !== "candidate" && fields.has("issue")) {
    failures.push(`${file}: \`issue\` applies only to a \`candidate\` smell`);
  }

  if (status === "gated") {
    const rule = get("rule");

    if (!rule)
      failures.push(`${file}: a \`gated\` smell needs \`rule\`: the gate rule that enforces it`);
    else if (!enforcedText.includes(`\`${rule}\``)) {
      failures.push(
        `${file}: \`rule: ${rule}\` is not in ${ENFORCED}. Name a rule that a gate runs.`,
      );
    }
  } else if (fields.has("rule")) {
    failures.push(`${file}: \`rule\` applies only to a \`gated\` smell`);
  }

  if (status === "stays-review" && rung !== "none") {
    failures.push(
      `${file}: a \`stays-review\` smell has \`rung: none\`; the Mechanism section says why`,
    );
  }

  if (status !== "stays-review" && rung === "none") {
    failures.push(
      `${file}: \`rung: none\` means no check can state the rule; set \`status: stays-review\``,
    );
  }

  if (status === "review" && CHECKABLE_RUNGS.has(rung) && distinctPrs(smell) >= PROMOTION_HITS) {
    failures.push(
      `${file}: reviews found this smell in ${distinctPrs(smell)} PRs, and a ${rung} check can state it. ` +
        "Write the gate and set `status: gated`, or file an issue and set `status: candidate`, " +
        "or set `status: stays-review` with the reason in `## Mechanism`.",
    );
  }

  return failures;
}

/**
 * @param {string} root
 * @returns {{ id: string, smell: Smell }[]}
 */
export function loadSmells(root = ROOT) {
  const dir = join(root, SMELL_DIR);

  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .toSorted()
    .map((name) => {
      const id = name.slice(0, -3);
      const file = `${SMELL_DIR}/${name}`;

      return { id, smell: parseSmell(file, readFileSync(join(dir, name), "utf8")) };
    });
}

/** @param {string} cell */
function escapeCell(cell) {
  return cell.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** @param {Smell} smell */
function mechanismLead(smell) {
  return paragraph((smell.sections.get("Mechanism") ?? "").split("\n\n")[0]?.split("\n") ?? []);
}

/** @param {Smell} smell */
function statusText(smell) {
  const status = smell.fields.get("status");

  if (status === "candidate") return `Candidate, ${smell.fields.get("issue")}`;

  if (status === "stays-review") return "Stays review";

  if (status === "gated") return `Gated by \`${smell.fields.get("rule")}\``;

  const feasibility = smell.fields.get("feasibility") ?? "";

  return feasibility.charAt(0).toUpperCase() + feasibility.slice(1);
}

/** The index names the status before the feasibility, which the queue implies. */
function indexStatusText(smell) {
  return smell.fields.get("status") === "review"
    ? `Review, ${smell.fields.get("feasibility")}`
    : statusText(smell);
}

/** @param {{ id: string, smell: Smell }[]} smells */
function bySection(smells) {
  return SECTIONS.map((section) => ({
    section,
    smells: smells.filter(({ smell }) => smell.fields.get("section") === section),
  })).filter((group) => group.smells.length > 0);
}

const STATUS_ORDER = new Map([
  ["candidate", 0],
  ["review", 1],
  ["stays-review", 2],
]);

const FEASIBILITY_ORDER = new Map([
  ["high", 0],
  ["medium", 1],
  ["low", 2],
]);

/**
 * @param {{ id: string, smell: Smell }[]} smells
 * @returns {string}
 */
export function renderIndex(smells) {
  const out = [
    `<!-- Generated by scripts/smells.mjs from the smell files in this directory. Run \`${WRITE_COMMAND}\` after you change one. -->`,
    "",
    "# Smells",
    "",
    "A smell is a code shape that review catches. Each file here holds one smell: the rule, the reason, a Bad and a Good example, the mechanism that could enforce it, and the PRs where a review found it.",
    "",
    "## Record a smell from a review",
    "",
    "A review that finds a smell records it, so the next review and the next gate can use it.",
    "",
    '- The finding matches a smell here: `node scripts/smells.mjs hit <id> <pr> "<file or item>: <finding>"`.',
    "- The finding is a new smell that can occur again: `node scripts/smells.mjs new <id> <section>`. Fill in each section. Take the Bad example from the diff and the Good example from the fix.",
    "- A one-off design finding is not a smell. Do not record it.",
    "",
    `When a smell has hits in ${PROMOTION_HITS} PRs and a rung that a check can state, \`pnpm check:smells\` fails until it gets a decision. Write the gate and set \`status: gated\`, file an issue and set \`status: candidate\`, or set \`status: stays-review\` with the reason. [gate-design.md](../gate-design.md) tells which rung a new gate gets. The Bad example of a smell becomes an \`invalid\` case of its rule, and the Good example a \`valid\` case.`,
    "",
    "A `gated` smell stays here for its examples and its ledger. [review-checklist.md](../review-checklist.md) lists only the smells that review still owns.",
    "",
  ];

  for (const { section, smells: group } of bySection(smells)) {
    out.push(`## ${section}`, "", "| Smell | Status | Rung | PRs |", "| --- | --- | --- | --- |");

    for (const { id, smell } of group) {
      out.push(
        `| [${escapeCell(smell.title)}](./${id}.md) | ${escapeCell(indexStatusText(smell))} | ${smell.fields.get("rung")} | ${distinctPrs(smell)} |`,
      );
    }

    out.push("");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * A relative link in a smell file resolves from `smells/`; the checklist sits one
 * directory up, so the copy rewrites `../x.md` to `./x.md` and `./x.md` to
 * `./smells/x.md`.
 *
 * @param {string} text
 */
function linksFromChecklist(text) {
  return text.replace(/\]\((\.\.?\/)/g, (_, prefix) => (prefix === "../" ? "](./" : "](./smells/"));
}

/**
 * @param {{ id: string, smell: Smell }[]} smells
 * @returns {string}
 */
export function renderChecklist(smells) {
  const open = smells.filter(({ smell }) => smell.fields.get("status") !== "gated");

  const out = [
    `<!-- Generated by scripts/smells.mjs from docs/reference/smells/. Edit the smell file, then run \`${WRITE_COMMAND}\`. -->`,
    "",
    "# Review checklist",
    "",
    "This checklist holds only the rules that no gate enforces. Apply it to the authored files of a diff. Do not style-review a generated file. Compare it with its source.",
    "",
    "- A gate fails `pnpm check`, `pnpm check-types`, `pnpm lint` or CI. [enforced-rules.md](./enforced-rules.md) lists every gate rule. Do not report a violation of one of those rules.",
    "- When a gate covers part of a rule, this checklist holds only the part the gate cannot see.",
    "- [gate-design.md](./gate-design.md#queue-review-only-rules-and-the-mechanism-that-would-enforce-them) says which mechanism could enforce each rule here, and which rules stay review.",
    "- This checklist is the surface sweep. [structural-review.md](./structural-review.md) covers the search for a better structure (up) and the proof of an invariant (down).",
    "",
    "Each rule has the rule and the reason. Its smell file has a Bad and a Good example and the PRs where a review found it. When you report a finding against a rule, record the hit. [smells/README.md](./smells/README.md) tells how, and how to add a new smell.",
    "",
  ];

  for (const { section, smells: group } of bySection(open)) {
    out.push(`## ${section}`, "");

    for (const { id, smell } of group) {
      const detail = smell.detail ? ` ${linksFromChecklist(smell.detail)}` : "";

      out.push(
        `- **${smell.title}**${detail} [Smell](./smells/${id}.md).`,
        `  ${linksFromChecklist(smell.why)}`,
      );
    }

    out.push("");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * @param {{ id: string, smell: Smell }[]} smells
 * @returns {string}
 */
export function renderQueue(smells) {
  const open = smells
    .filter(({ smell }) => STATUS_ORDER.has(smell.fields.get("status") ?? ""))
    .toSorted((left, right) => {
      const status = (entry) => STATUS_ORDER.get(entry.smell.fields.get("status") ?? "") ?? 9;

      const feasibility = (entry) =>
        FEASIBILITY_ORDER.get(entry.smell.fields.get("feasibility") ?? "") ?? 9;

      return (
        status(left) - status(right) ||
        feasibility(left) - feasibility(right) ||
        distinctPrs(right.smell) - distinctPrs(left.smell) ||
        left.id.localeCompare(right.id)
      );
    });

  return [
    QUEUE_START,
    `<!-- Generated by scripts/smells.mjs from docs/reference/smells/. Run \`${WRITE_COMMAND}\` after you change a smell. -->`,
    "",
    "| Smell (checklist section) | Mechanism | Status | PRs |",
    "| --- | --- | --- | --- |",
    ...open.map(({ id, smell }) =>
      [
        "",
        `[\`${id}\`](./smells/${id}.md) (${smell.fields.get("section")})`,
        escapeCell(mechanismLead(smell)),
        escapeCell(statusText(smell)),
        String(distinctPrs(smell)),
        "",
      ]
        .join(" | ")
        .trim(),
    ),
    QUEUE_END,
  ].join("\n");
}

/**
 * Puts the rendered queue between the markers of gate-design.md.
 *
 * @param {string} doc
 * @param {string} queue
 */
export function spliceQueue(doc, queue) {
  const start = doc.indexOf(QUEUE_START);
  const end = doc.indexOf(QUEUE_END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${GATE_DESIGN} must hold one \`${QUEUE_START}\` … \`${QUEUE_END}\` region`);
  }

  return `${doc.slice(0, start)}${queue}${doc.slice(end + QUEUE_END.length)}`;
}

/**
 * Every failure of the catalog in `root`, and the views it should produce.
 *
 * @param {string} root
 */
export function catalogState(root = ROOT) {
  const smells = loadSmells(root);
  const enforcedText = readFileSync(join(root, ENFORCED), "utf8");
  const failures = smells.flatMap(({ id, smell }) => smellFailures(smell, { id, enforcedText }));

  // An empty catalog renders an empty checklist and passes every rule above.
  if (smells.length === 0)
    failures.push(`${SMELL_DIR} holds no smell file, so the checklist would be empty`);
  const titles = new Map();

  for (const { id, smell } of smells) {
    const other = titles.get(smell.title);

    if (other) failures.push(`${SMELL_DIR}/${id}.md: the rule repeats the rule of ${other}`);
    titles.set(smell.title, id);
  }

  const views = new Map([
    [INDEX, renderIndex(smells)],
    [CHECKLIST, renderChecklist(smells)],
    [GATE_DESIGN, spliceQueue(readFileSync(join(root, GATE_DESIGN), "utf8"), renderQueue(smells))],
  ]);

  return { smells, failures, views };
}

/** @param {string} id @param {string} section */
export function scaffold(id, section) {
  return [
    "---",
    `id: ${id}`,
    `section: ${section}`,
    "status: review",
    "rung: ast",
    "feasibility: medium",
    "---",
    "",
    `# ${PLACEHOLDER}: the rule, as one imperative sentence.`,
    "",
    `Why: ${PLACEHOLDER}: the concrete harm, in one sentence. Example: #<pr>.`,
    "",
    "## Bad",
    "",
    "```ts",
    `// ${PLACEHOLDER}: the shape from the diff, cut to the lines that show it.`,
    "```",
    "",
    "## Good",
    "",
    "```ts",
    `// ${PLACEHOLDER}: the shape that the fix gave.`,
    "```",
    "",
    "## Mechanism",
    "",
    `${PLACEHOLDER}: the rung that could state it, and what it would read. Or why no check can separate the good case from the bad case.`,
    "",
    "## Hits",
    "",
  ].join("\n");
}

/**
 * Adds one hit line under `## Hits`.
 *
 * @param {string} text the smell file
 * @param {number} pr
 * @param {string} note
 */
export function addHit(text, pr, note) {
  const line = `- #${pr} ${note.trim()}`;

  if (!HIT_PATTERN.test(line))
    throw new Error(`the hit must read \`- #<pr> <where>: <finding>\`: ${line}`);

  if (text.split("\n").includes(line)) throw new Error(`the smell already has this hit: ${line}`);

  const marker = "\n## Hits\n";
  const at = text.indexOf(marker);

  if (at === -1) throw new Error("the smell file has no `## Hits` section");

  const after = text.slice(at + marker.length);
  const next = after.search(/^## /m);
  const hits = (next === -1 ? after : after.slice(0, next)).trimEnd();
  const rest = next === -1 ? "" : `\n${after.slice(next)}`;

  return `${text.slice(0, at)}${marker}${hits ? `${hits}\n` : "\n"}${line}\n${rest}`;
}

/**
 * @param {Map<string, string>} views
 * @param {string} root
 */
export function staleViewFailures(views, root = ROOT) {
  return [...views]
    .filter(([file, content]) => readFileSync(join(root, file), "utf8") !== content)
    .map(([file]) => `${file} is stale. Run \`${WRITE_COMMAND}\` and commit the result.`);
}

function writeViews(views) {
  for (const [file, content] of views) writeFileSync(join(ROOT, file), content);
}

function main(args) {
  const [command] = args;

  if (command === "hit") {
    const [, id, pr, ...note] = args;
    const file = join(ROOT, SMELL_DIR, `${id}.md`);

    if (!id || !/^#?\d+$/.test(pr ?? "") || note.length === 0) {
      throw new Error('usage: node scripts/smells.mjs hit <id> <pr> "<file or item>: <finding>"');
    }

    if (!existsSync(file))
      throw new Error(`no smell \`${id}\`. Run \`node scripts/smells.mjs new ${id} <section>\`.`);

    writeFileSync(
      file,
      addHit(readFileSync(file, "utf8"), Number(pr.replace("#", "")), note.join(" ")),
    );
  } else if (command === "new") {
    const [, id, ...words] = args;
    const section = words.join(" ");
    const file = join(ROOT, SMELL_DIR, `${id}.md`);

    if (!id || !ID_PATTERN.test(id))
      throw new Error("usage: node scripts/smells.mjs new <kebab-id> <section>");

    if (!SECTIONS.includes(section))
      throw new Error(`the section must be one of: ${SECTIONS.join(", ")}`);

    if (existsSync(file)) throw new Error(`${SMELL_DIR}/${id}.md exists. Add a hit instead.`);

    writeFileSync(file, scaffold(id, section));
    console.log(
      `Wrote ${SMELL_DIR}/${id}.md. Fill in each ${PLACEHOLDER}, then add the first hit.`,
    );

    return;
  } else if (command === "queue") {
    const { smells } = catalogState();

    for (const { id, smell } of smells) {
      const status = smell.fields.get("status");
      const rung = smell.fields.get("rung") ?? "";

      const due =
        status === "review" && CHECKABLE_RUNGS.has(rung) && distinctPrs(smell) >= PROMOTION_HITS;

      if (status === "candidate" || due) {
        console.log(`${id}\t${statusText(smell)}\t${rung}\t${distinctPrs(smell)} PRs`);
      }
    }

    return;
  } else if (command && command !== "--check") {
    throw new Error(`unknown command \`${command}\`. Read the header of scripts/smells.mjs.`);
  }

  const { failures, views } = catalogState();

  if (command === "--check") failures.push(...staleViewFailures(views));
  else writeViews(views);

  if (failures.length > 0) {
    console.error(`Smell catalog: ${failures.length} failure(s)\n`);

    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
