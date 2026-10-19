// Builds docs/reference/enforced-rules.md: the catalog of every rule that a gate
// enforces, generated from the files that define the rules.
//
// A rule's enforcement status has one home: the gate that runs it. This script
// reads those gates and writes what they say, so the catalog cannot drift from
// them and no person keeps a second table by hand. The review checklist
// (docs/reference/review-checklist.md) then holds only the rules that no gate
// enforces.
//
// Sources, and what each contributes:
//   - .oxlintrc.json (JSONC): every rule at `error`, its options, and the
//     `overrides` scopes that turn it off or on. Built-in rules get the docs
//     link and the type-aware flag from `oxlint --rules -f json`.
//   - each `jsPlugins` entry in that config: the rule's own
//     `meta.docs.description`.
//   - scripts/consolidation-rules.mjs and scripts/test-tautology-rules.mjs: each
//     row's `id`, `severity` and `fix`.
//   - package.json and .github/workflows/ci.yml: which check scripts run in
//     `pnpm check` and in CI, with the first comment paragraph of each script.
//
// The text in the catalog is the rule's own text. Do not add per-rule prose
// here; change the rule's description, message or `fix` at its source.
//
// Usage: node scripts/enforced-rules-catalog.mjs [--check]
//   (no flag)  write the catalog.
//   --check    write nothing; exit non-zero when the committed catalog differs
//              from what the sources produce now.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RULES as CONSOLIDATION_RULES } from "./consolidation-rules.mjs";
import { ROOT_OXLINT_CONFIG, stripJsonComments } from "./oxlint-config.mjs";
import { RULES as TAUTOLOGY_RULES } from "./test-tautology-rules.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CATALOG = "docs/reference/enforced-rules.md";

const CI_WORKFLOW = ".github/workflows/ci.yml";

const WRITE_COMMAND = "pnpm rules:catalog";

const CHECK = process.argv.includes("--check");

const OXLINT_BIN = resolve(ROOT, "node_modules/.bin/oxlint");

/**
 * The `oxlint --rules` scope for a config prefix, where the two spell it
 * differently. Any other prefix maps by replacing `-` with `_`.
 */
const SCOPE_ALIASES = new Map([
  ["react-hooks", "react"],
  ["next", "nextjs"],
]);

/** The severity spellings that fail `pnpm lint`. */
const ERROR_SPELLINGS = new Set(["error", "deny", 2]);

/** The severity spellings that turn a rule off. */
const OFF_SPELLINGS = new Set(["off", "allow", 0]);

/**
 * @typedef {object} BuiltinRuleInfo
 * @property {string}  docsUrl
 * @property {boolean} typeAware
 */

/**
 * @typedef {object} LintRule
 * @property {string}   name        The config key, such as `typescript/no-floating-promises`.
 * @property {unknown[]} options    The options after the severity.
 * @property {string[]} onlyIn      Files of the overrides that turn the rule on, when the root does not.
 * @property {string[][]} offIn     Files of each override that turns the rule off.
 */

/**
 * @typedef {object} FenceGroup
 * @property {string[]} group
 * @property {string}   message
 * @property {string[][]} allowedIn  Files of each override that omits this root group.
 * @property {string[]} onlyIn       Files of the override that adds this group, when the root does not.
 */

const config = readOxlintConfig();

const builtins = readBuiltinRules();

const plugins = await readPluginDescriptions(config.jsPlugins);

const lintRules = collectLintRules(config);

const fences = collectFences(config);

const scripts = collectCheckScripts();

const catalog = render();

if (CHECK) {
  const path = resolve(ROOT, CATALOG);
  const committed = existsSync(path) ? readFileSync(path, "utf8") : null;

  if (committed !== catalog) {
    console.error(
      committed === null
        ? `${CATALOG} is missing. Run \`${WRITE_COMMAND}\` and commit the result.`
        : `${CATALOG} is stale: the rule sources changed and the catalog did not. Run \`${WRITE_COMMAND}\` and commit the result.`,
    );
    process.exit(1);
  }

  console.log(`${CATALOG} matches its sources.`);
} else {
  writeFileSync(resolve(ROOT, CATALOG), catalog);
  console.log(`Wrote ${CATALOG}.`);
}

/**
 * The root oxlint config as written, comments removed.
 *
 * The tracked text is read, not `oxlint --print-config`: the resolved config drops
 * every JS-plugin rule (see scripts/check-oxlint-plugin.mjs), so it would list no
 * `anti-slop`, `alfred` or `tailwindcss` rule.
 *
 * @returns {{ rules: Map<string, unknown>, overrides: { files: string[], rules: Map<string, unknown> }[], jsPlugins: string[] }}
 */
function readOxlintConfig() {
  const parsed = JSON.parse(
    stripJsonComments(readFileSync(resolve(ROOT, ROOT_OXLINT_CONFIG), "utf8")),
  );

  const jsPlugins = Array.isArray(parsed.jsPlugins) ? parsed.jsPlugins.map(String) : [];
  const overrides = Array.isArray(parsed.overrides) ? parsed.overrides : [];

  return {
    rules: new Map(Object.entries(parsed.rules ?? {})),
    overrides: overrides.map((entry) => ({
      files: Array.isArray(entry.files) ? entry.files.map(String) : [],
      rules: new Map(Object.entries(entry.rules ?? {})),
    })),
    jsPlugins,
  };
}

/**
 * Every built-in rule oxlint knows, keyed `<scope>/<name>`.
 *
 * @returns {Map<string, BuiltinRuleInfo>}
 */
function readBuiltinRules() {
  const stdout = execFileSync(OXLINT_BIN, ["--rules", "-f", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const parsed = JSON.parse(stdout);

  if (!Array.isArray(parsed)) throw new Error("`oxlint --rules -f json` did not emit an array.");

  /** @type {Map<string, BuiltinRuleInfo>} */
  const rules = new Map();

  for (const entry of parsed) {
    rules.set(`${entry.scope}/${entry.value}`, {
      docsUrl: String(entry.docs_url),
      typeAware: entry.type_aware === true,
    });
  }

  return rules;
}

/**
 * The `meta.docs.description` of every rule each JS plugin registers, keyed
 * `<plugin>/<rule>`.
 *
 * @param {string[]} specifiers The config's `jsPlugins` entries.
 * @returns {Promise<Map<string, { plugin: string, description: string }>>}
 */
async function readPluginDescriptions(specifiers) {
  /** @type {Map<string, { plugin: string, description: string }>} */
  const descriptions = new Map();

  for (const specifier of specifiers) {
    const url = specifier.startsWith(".")
      ? pathToFileURL(resolve(ROOT, specifier)).href
      : specifier;

    const module = await import(url);
    const plugin = module.default;
    const name = String(plugin.meta.name);

    for (const [rule, definition] of Object.entries(plugin.rules)) {
      const description = definition.meta?.docs?.description;

      descriptions.set(`${name}/${rule}`, {
        plugin: name,
        description: description === undefined ? "" : String(description),
      });
    }
  }

  return descriptions;
}

/**
 * The severity of a rule value, with its options.
 *
 * @param {unknown} value
 * @returns {{ severity: "error" | "off" | "other", options: unknown[] }}
 */
function readSeverity(value) {
  const [level, ...options] = Array.isArray(value) ? value : [value];

  if (ERROR_SPELLINGS.has(level)) return { severity: "error", options };

  if (OFF_SPELLINGS.has(level)) return { severity: "off", options };

  return { severity: "other", options };
}

/**
 * Every rule that fails `pnpm lint` somewhere, except `no-restricted-imports`,
 * which {@link collectFences} renders group by group.
 *
 * @param {ReturnType<typeof readOxlintConfig>} source
 * @returns {LintRule[]}
 */
function collectLintRules(source) {
  /** @type {Map<string, LintRule>} */
  const rules = new Map();

  for (const [name, value] of source.rules) {
    const { severity, options } = readSeverity(value);

    if (severity === "error") rules.set(name, { name, options, onlyIn: [], offIn: [] });
  }

  for (const override of source.overrides) {
    for (const [name, value] of override.rules) {
      const { severity, options } = readSeverity(value);
      const known = rules.get(name);

      if (severity === "off" && known) known.offIn.push(override.files);

      if (severity === "error" && !source.rules.has(name)) {
        const added = known ?? { name, options, onlyIn: [], offIn: [] };

        added.onlyIn.push(...override.files);
        rules.set(name, added);
      }
    }
  }

  rules.delete("no-restricted-imports");

  return [...rules.values()].sort((a, b) => compareText(a.name, b.name));
}

/**
 * The `no-restricted-imports` groups, with the scopes each one does not apply to.
 *
 * An override REPLACES the rule's options, so a root group that an override does
 * not restate is allowed in that override's files. A group that only an override
 * carries applies only there.
 *
 * @param {ReturnType<typeof readOxlintConfig>} source
 * @returns {FenceGroup[]}
 */
function collectFences(source) {
  /** @type {Map<string, FenceGroup>} */
  const groups = new Map();
  const rootGroups = fenceGroups(source.rules.get("no-restricted-imports"));

  for (const { group, message } of rootGroups) {
    groups.set(JSON.stringify(group), { group, message, allowedIn: [], onlyIn: [] });
  }

  for (const override of source.overrides) {
    if (!override.rules.has("no-restricted-imports")) continue;

    const restated = fenceGroups(override.rules.get("no-restricted-imports"));
    const keys = new Set(restated.map(({ group }) => JSON.stringify(group)));

    for (const [key, fence] of groups) {
      if (fence.onlyIn.length === 0 && !keys.has(key)) fence.allowedIn.push(override.files);
    }

    for (const { group, message } of restated) {
      const key = JSON.stringify(group);

      if (!groups.has(key))
        groups.set(key, { group, message, allowedIn: [], onlyIn: override.files });
    }
  }

  return [...groups.values()];
}

/**
 * The `patterns` groups of one `no-restricted-imports` value.
 *
 * @param {unknown} value
 * @returns {{ group: string[], message: string }[]}
 */
function fenceGroups(value) {
  const { severity, options } = readSeverity(value);

  if (severity !== "error") return [];

  return options.flatMap((option) => {
    const patterns = option instanceof Object ? Reflect.get(option, "patterns") : undefined;

    if (!Array.isArray(patterns)) return [];

    return patterns.map((pattern) => ({
      group: Array.isArray(pattern.group) ? pattern.group.map(String) : [],
      message: String(pattern.message ?? ""),
    }));
  });
}

/**
 * Every root script that `pnpm check` or the CI workflow runs and that is not
 * only a chain of other scripts.
 *
 * @returns {{ name: string, command: string, inCheck: boolean, inCi: boolean, summary: string }[]}
 */
function collectCheckScripts() {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

  /** @type {Map<string, string>} */
  const commands = new Map(
    Object.entries(manifest.scripts ?? {}).map(([name, command]) => [name, String(command)]),
  );

  const workflow = readFileSync(resolve(ROOT, CI_WORKFLOW), "utf8");

  const ciRoots = [...workflow.matchAll(/\bpnpm\s+([\w:-]+)/g)]
    .map((match) => match[1])
    .filter((name) => commands.has(name));

  const inCheck = reachableScripts(["check"], commands);
  const inCi = reachableScripts(ciRoots, commands);

  const names = [...new Set([...inCheck, ...inCi])].filter(
    (name) => !isChain(commands.get(name) ?? ""),
  );

  return names.sort(compareText).map((name) => {
    const command = commands.get(name) ?? "";

    return {
      name,
      command,
      inCheck: inCheck.has(name),
      inCi: inCi.has(name),
      summary: scriptSummary(command),
    };
  });
}

/**
 * The scripts that the roots run, through every `pnpm <script>` step.
 *
 * @param {string[]} roots
 * @param {Map<string, string>} commands
 * @returns {Set<string>}
 */
function reachableScripts(roots, commands) {
  const seen = new Set();
  const queue = [...roots];

  while (queue.length > 0) {
    const name = queue.shift();

    if (name === undefined || seen.has(name) || !commands.has(name)) continue;
    seen.add(name);

    for (const match of (commands.get(name) ?? "").matchAll(/\bpnpm\s+([\w:-]+)/g)) {
      queue.push(match[1]);
    }
  }

  return seen;
}

/**
 * Whether a command only runs other root scripts.
 *
 * @param {string} command
 */
function isChain(command) {
  return command.split("&&").every((step) => /^\s*pnpm\s+[\w:-]+\s*$/.test(step));
}

/**
 * The first comment paragraph of the script file a command runs, or "".
 *
 * @param {string} command
 */
function scriptSummary(command) {
  const match = /^node\s+(scripts\/[\w.-]+\.mjs)\b/.exec(command);

  if (!match) return "";

  const lines = readFileSync(resolve(ROOT, match[1]), "utf8").split("\n");
  const paragraph = [];

  for (const line of lines) {
    if (line.startsWith("#!")) continue;

    const text = /^\s*(?:\/\/|\/\*\*|\*(?!\/))\s?(.*)$/.exec(line);

    if (!text) break;

    const content = text[1].trim();

    if (content === "") {
      if (paragraph.length > 0) break;
      continue;
    }

    paragraph.push(content);
  }

  return paragraph.join(" ");
}

/**
 * The docs link and rung for a built-in rule.
 *
 * @param {string} name
 * @returns {BuiltinRuleInfo}
 */
function builtinInfo(name) {
  const [prefix, rule] = name.includes("/") ? name.split("/", 2) : ["eslint", name];
  const scope = SCOPE_ALIASES.get(prefix) ?? prefix.replaceAll("-", "_");
  const info = builtins.get(`${scope}/${rule}`);

  if (!info) {
    throw new Error(
      `${ROOT_OXLINT_CONFIG} enables \`${name}\`, but \`oxlint --rules\` lists no \`${scope}/${rule}\`. Add the prefix to SCOPE_ALIASES in scripts/enforced-rules-catalog.mjs.`,
    );
  }

  return info;
}

/** @returns {string} */
function render() {
  const pluginRules = lintRules.filter((rule) => plugins.has(rule.name));
  const builtinRules = lintRules.filter((rule) => !plugins.has(rule.name));
  const pluginNames = [...new Set(pluginRules.map((rule) => plugins.get(rule.name)?.plugin ?? ""))];

  const out = [
    "<!-- Generated by scripts/enforced-rules-catalog.mjs. Do not edit this file by hand. -->",
    `<!-- After you change a rule source, run \`${WRITE_COMMAND}\` and commit the result. -->`,
    "",
    "# Enforced rules",
    "",
    "This catalog lists every rule that a gate enforces. A script generates it from the rule sources, so it cannot drift from them.",
    "",
    "- A reviewer does not report a violation of a rule here. The gate already fails on it.",
    "- The rules that no gate enforces are in [review-checklist.md](./review-checklist.md).",
    "- To choose a gate for a new rule, read [gate-design.md](./gate-design.md).",
    "",
    `When you add, remove or change a rule in \`${ROOT_OXLINT_CONFIG}\`, a JS plugin, \`scripts/consolidation-rules.mjs\`, \`scripts/test-tautology-rules.mjs\`, \`package.json\` or \`${CI_WORKFLOW}\`, run \`${WRITE_COMMAND}\`. \`pnpm check:rules-catalog\` fails while this file is stale.`,
    "",
    "## Lint rules: oxlint built-ins",
    "",
    `\`pnpm lint\` fails on each rule below. A type-aware rule reads the type of an expression (rung 2 in gate-design.md). Each rule is on for every file that \`pnpm lint\` reads, except where the scope says otherwise. The comment above each key in \`${ROOT_OXLINT_CONFIG}\` gives the reason for the rule and its options.`,
    "",
    "| Rule | Type-aware | Scope | Options |",
    "| --- | --- | --- | --- |",
    ...builtinRules.map((rule) => {
      const info = builtinInfo(rule.name);

      return row([
        `[\`${rule.name}\`](${info.docsUrl})`,
        info.typeAware ? "yes" : "no",
        scopeText(rule),
        optionsText(rule.options),
      ]);
    }),
    "",
  ];

  for (const pluginName of pluginNames) {
    out.push(
      `## Lint rules: \`${pluginName}\` plugin`,
      "",
      "`pnpm lint` fails on each rule below. The description is the rule's own `meta.docs.description`.",
      "",
      "| Rule | Scope | Description |",
      "| --- | --- | --- |",
      ...pluginRules
        .filter((rule) => plugins.get(rule.name)?.plugin === pluginName)
        .map((rule) =>
          row([
            `\`${rule.name}\``,
            scopeText(rule),
            [plugins.get(rule.name)?.description ?? "", optionsText(rule.options)]
              .filter(Boolean)
              .join(" Options: "),
          ]),
        ),
      "",
    );
  }

  out.push(
    "## Import fences: `no-restricted-imports`",
    "",
    "`pnpm lint` fails when a file imports a specifier in a group below. An override that does not restate a group allows that group in its files. `pnpm check:oxlint-config` keeps each restated group identical to the root group.",
    "",
    "| Specifiers | Allowed in | Message |",
    "| --- | --- | --- |",
    ...fences.map((fence) =>
      row([
        fence.group.map((specifier) => `\`${specifier}\``).join(", "),
        fence.onlyIn.length > 0
          ? `Applies only in ${globList(fence.onlyIn)}`
          : fence.allowedIn.map(globList).join("; ") || "nowhere",
        fence.message,
      ]),
    ),
    "",
    ...rowTable({
      title: "Consolidation rows: `pnpm check:consolidation`",
      intro:
        "A `gate` row fails `pnpm check`. `.claude/hooks/helper-hints.mjs` also shows each row's fix at edit time. A line that ends in `// drift-ok: <reason>` is exempt.",
      rows: CONSOLIDATION_RULES,
    }),
    ...rowTable({
      title: "Test-tautology rows: `pnpm check:test-tautology`",
      intro:
        "A `gate` row fails `pnpm check`. A `// tautology-ok: <reason>` marker on the match or the comment above it exempts the match.",
      rows: TAUTOLOGY_RULES,
    }),
    "## Check scripts",
    "",
    `Each script below runs in \`pnpm check\`, in CI (\`${CI_WORKFLOW}\`), or in both. The summary is the first comment paragraph of the script file.`,
    "",
    "| Script | `pnpm check` | CI | Command | Summary |",
    "| --- | --- | --- | --- | --- |",
    ...scripts.map((script) =>
      row([
        `\`${script.name}\``,
        script.inCheck ? "yes" : "no",
        script.inCi ? "yes" : "no",
        `\`${script.command}\``,
        script.summary,
      ]),
    ),
    "",
  );

  return out.join("\n");
}

/**
 * The gate table and the hint table of one row source.
 *
 * @param {{ title: string, intro: string, rows: { id: string, severity: string, fix: string }[] }} table
 * @returns {string[]}
 */
function rowTable({ title, intro, rows }) {
  const sorted = [...rows].sort((a, b) => compareText(a.id, b.id));
  const gates = sorted.filter((rule) => rule.severity === "gate");
  const hints = sorted.filter((rule) => rule.severity !== "gate");

  return [
    `## ${title}`,
    "",
    intro,
    "",
    "| Row | Fix |",
    "| --- | --- |",
    ...gates.map((rule) => row([`\`${rule.id}\``, rule.fix])),
    "",
    "These `hint` rows do not fail a build. They advise at edit time only.",
    "",
    "| Row | Fix |",
    "| --- | --- |",
    ...hints.map((rule) => row([`\`${rule.id}\``, rule.fix])),
    "",
  ];
}

/**
 * Where a rule applies, when that is not every linted file.
 *
 * @param {LintRule} rule
 */
function scopeText(rule) {
  const parts = [];

  if (rule.onlyIn.length > 0) parts.push(`Only in ${globList(rule.onlyIn)}`);

  if (rule.offIn.length > 0) parts.push(`Off in ${rule.offIn.map(globList).join("; ")}`);

  return parts.join(". ");
}

/** @param {string[]} files */
function globList(files) {
  return files.map((file) => `\`${file}\``).join(", ");
}

/** @param {unknown[]} options */
function optionsText(options) {
  return options.length === 0
    ? ""
    : code(options.map((option) => JSON.stringify(option)).join(", "));
}

/**
 * A Markdown code span whose fence is longer than any backtick run inside it.
 *
 * @param {string} text
 */
function code(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);

  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

/**
 * One Markdown table row. A cell keeps no line break, and a `|` is escaped.
 *
 * @param {string[]} cells
 */
function row(cells) {
  return `| ${cells.map((cell) => cell.replaceAll("\n", " ").replaceAll("|", "\\|")).join(" | ")} |`;
}

/**
 * Code-unit order, so the output does not depend on the ICU data of the machine.
 *
 * @param {string} a
 * @param {string} b
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
