// Fails when a rule in one of the repo's oxlint JS plugins is untested,
// unregistered, or registered but not actually enforced by the root config.
//
// Two plugins live under `scripts/oxlint/`, and this gate discovers both from
// the directory, so a new plugin or a new rule is covered without an edit here:
// - `anti-slop/` is vendored third-party rule source (see its README);
// - `alfred/` is first-party: rules that need the AST or scope analysis, which
//   a regex in `scripts/consolidation-rules.mjs` cannot give (see its README).
// Nothing else in this repo reaches them: no package's `check-types` covers
// `scripts/`, `pnpm -r test` cannot see them because `scripts/` is not a
// workspace, and a rule that is present but never registered lints nothing while
// looking exactly like a rule that works. This gate closes all three gaps.
//
// The enablement claim is the one worth explaining. It is NOT read out of the
// config: `oxlint --print-config` omits every JS-plugin rule from its resolved
// `rules` object — measured, and true of `tailwindcss/*` here too — so a gate
// built on `resolvedOxlintConfig` would parse a config in which these rules do
// not appear and pass while reading nothing. Instead each rule is DRIVEN: the
// gate writes snippets that violate it to a temp directory, lints that
// directory through `--config .oxlintrc.json`, and demands the rule report each
// one at `error`. That proves registration, enablement and severity end to end,
// and it is the claim `pnpm lint` on a clean tree cannot make.
//
// A clean tree is why the drive exists. Every rule had zero violations when it
// was adopted, so `pnpm lint` is silent whether it works or is switched off.
//
// Where a rule's snippets come from:
// - An entry in PROBES below, when the rule has one. Each anti-slop rule does,
//   because upstream fixtures carry traps for a root-config drive (see the `vi`
//   note).
// - Otherwise, the rule's own `invalid` fixture cases. The gate captures them
//   at run time from `RuleTester#run` while it runs the fixtures, so it reads
//   the values the fixture file built, not its text. Only a case that the root
//   config can reproduce counts: one with no `filename`, `options`, `settings`,
//   `languageOptions` or hooks. A rule needs at least one.
//
// The fixtures are `<rule>.rule-test.ts`, renamed from upstream's `<rule>.test.ts`.
// In this repo `*.test.ts` is a name with enforcement attached: `isScanFile` in
// ./test-id-prefixes.mjs claims every `*.test.ts` "wherever it lives" for the
// DB test-id census, whose walk only covers `packages` and `apps`. Vendoring
// under the upstream name put three files inside that scan surface and outside
// its walk, and that check's own self-test failed — correctly — on the
// disagreement. These files are RuleTester fixtures this gate runs, not a suite
// any workspace runner owns, so the name should say so.
//
// Usage: node scripts/check-oxlint-plugin.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PLUGINS_DIR = join("scripts", "oxlint");

// Fail fast when the interpreter is older than package.json's `engines.node`.
// The symptom otherwise is an oxlint plugin-load crash ("Unknown file extension
// \".ts\"") that this gate reports as "registered but NOT enforced" failures —
// a misdiagnosis that points at .oxlintrc.json instead of at the interpreter.
// oxlint loads each plugin through Node's native TS support, and this gate
// imports the `.rule-test.ts` fixtures the same way, so anything below the
// engines floor cannot drive a single rule.
const ENGINES_NODE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).engines?.node;

const ENGINES_FLOOR = /^>=(\d+)\./.exec(String(ENGINES_NODE ?? ""));

const nodeMajor = Number.parseInt(process.versions.node, 10);

if (ENGINES_FLOOR !== null && nodeMajor < Number(ENGINES_FLOOR[1])) {
  console.error(
    `This gate is running on Node ${process.versions.node}, but package.json requires ` +
      `${ENGINES_NODE}. oxlint cannot load a .ts plugin below that floor, so no rule can be ` +
      `driven. Re-run on a qualifying Node (\`nvm use\` reads .nvmrc).`,
  );
  process.exit(1);
}

const GATE_FILE = join("scripts", "check-oxlint-plugin.mjs");

const OXLINT_BIN = resolve(ROOT, "node_modules", ".bin", "oxlint");

// Explicit snippets, keyed `<plugin>/<rule>`. A rule with no entry here is
// driven with its own fixture cases (see the header).
//
// Each snippet must violate exactly its own rule. Keep the shape notes — the
// `vi` one is a trap that already produced a probe that passed for the wrong
// reason.
const PROBES = {
  // `vi` is deliberately left UNDECLARED. no-module-mocking resolves the binding
  // and ignores a local one (upstream treats `function f(jest: {mock(): void})`
  // as valid), so a `declare const vi` probe passes without the rule doing
  // anything.
  "anti-slop/no-module-mocking": `vi.mock("./user-store");\n`,
  "anti-slop/no-reflect-apply": `export const value = Reflect.apply(operation, owner, args);\n`,
  "anti-slop/no-widen-then-assert":
    `const source = { id: "second" };\n` +
    `const widened: unknown = source;\n` +
    `export const parsed = widened as { readonly id: string };\n`,
  "anti-slop/no-chained-type-assertions": `export const user = input as object as User;\n`,
  "anti-slop/no-known-value-widening":
    `type Handler = () => void;\n` +
    `const handlers: Record<string, Handler> = { start: startHandler };\n`,
  "anti-slop/no-object-parameters": `export function save(value: object) {}\n`,
  "anti-slop/no-runtime-typeof": `export const isString = typeof input === "string";\n`,
  "anti-slop/no-unknown-returns": `export function loadUser(): unknown { return input; }\n`,
  "anti-slop/no-unknown-type-aliases": `export type ExternalValue = unknown;\n`,
  "anti-slop/no-unsafe-dictionary-type": `export type Metadata = Record<string, unknown>;\n`,
  "anti-slop/require-readable-spacing": `export const first = 1;\nexport const second = 2;\n`,
};

// The control. Linted alongside the probes so "every probe reported its rule"
// cannot be satisfied by a rule that reports everything.
const CONTROL = `export const ok = { id: "second" };\n`;

const CONTROL_NAME = "control";

// The fixture-case keys the root config can reproduce. A case that sets any
// other key (`filename`, `options`, `settings`, `languageOptions`, a hook)
// makes a claim the root config does not, so the drive skips it.
const DRIVABLE_CASE_KEYS = new Set(["code", "name", "errors", "output"]);

const failures = [];

/**
 * The stdout a failed `execFileSync` captured before it threw. The drive below
 * reads output from a process it EXPECTS to exit non-zero — oxlint exits 1
 * because the probes are supposed to be rejected — so the throw is the normal
 * path and its `stdout` is the result.
 *
 * @param {unknown} error
 * @returns {string}
 */
function capturedStdout(error) {
  const stdout = /** @type {{ stdout?: unknown }} */ (error).stdout;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- normalizes exec-error stdout; the shape read IS the boundary parse
  return typeof stdout === "string" ? stdout : "";
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Discovery: which plugins and rules exist, and is each rule tested?
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PluginRule
 * @property {string} plugin  The plugin's `meta.name`, which is also its directory.
 * @property {string} rule    The rule id inside the plugin.
 * @property {string} rulesDir Repo-relative `rules/` directory.
 */

let pluginDirs;

try {
  pluginDirs = readdirSync(resolve(ROOT, PLUGINS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(ROOT, PLUGINS_DIR, name, "index.ts")))
    .sort();
} catch (error) {
  console.error(
    `${PLUGINS_DIR} could not be read (${errorText(error)}). Without it this gate would check nothing.`,
  );
  process.exit(1);
}

// A zero count is a failure, not a pass: it means the walk found no plugin and
// the gate compared nothing.
if (pluginDirs.length === 0) {
  console.error(
    `${PLUGINS_DIR} holds no plugin directory with an index.ts. A zero here means the walk is broken, ` +
      `not that the plugins are clean.`,
  );
  process.exit(1);
}

/** @type {PluginRule[]} */
const rules = [];

for (const plugin of pluginDirs) {
  const pluginDir = join(PLUGINS_DIR, plugin);
  const rulesDir = join(pluginDir, "rules");
  const indexFile = join(pluginDir, "index.ts");
  const indexSource = readFileSync(resolve(ROOT, indexFile), "utf8");
  const metaName = /meta:\s*\{\s*name:\s*"([a-z0-9-]+)"/.exec(indexSource)?.[1];

  if (metaName !== plugin) {
    failures.push(
      `${indexFile} declares meta.name ${metaName === undefined ? "(none)" : `"${metaName}"`}, not "${plugin}". ` +
        `oxlint reports and configures a rule as "<meta.name>/<rule>", so the directory and the name must agree.`,
    );
    continue;
  }

  let entries;

  try {
    entries = readdirSync(resolve(ROOT, rulesDir));
  } catch (error) {
    failures.push(`${rulesDir} could not be read (${errorText(error)}).`);
    continue;
  }

  const testModules = new Set(entries.filter((name) => name.endsWith(".rule-test.ts")));

  const present = entries
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".rule-test.ts"))
    .map((name) => name.slice(0, -".ts".length))
    .sort();

  if (present.length === 0) {
    failures.push(
      `${rulesDir} holds no rule module. A zero here means the walk is broken, not that the plugin is clean.`,
    );
    continue;
  }

  for (const rule of present) {
    if (!testModules.has(`${rule}.rule-test.ts`)) {
      failures.push(
        `${rulesDir}/${rule}.ts has no sibling ${rule}.rule-test.ts. Ship the fixtures with the rule; ` +
          `an untested rule that stops matching fails open and the tree stays green.`,
      );
    }
  }

  // Registration: is every rule wired into the plugin, and vice versa?
  const registered = [...indexSource.matchAll(/^\s*"([a-z0-9-]+)":\s*[A-Za-z][A-Za-z0-9]*Rule,$/gm)]
    .map((match) => match[1])
    .sort();

  if (registered.length === 0) {
    failures.push(
      `${indexFile} registers no rule, or its \`rules\` entries no longer match the shape this gate reads. ` +
        `Either way the plugin enforces nothing.`,
    );
    continue;
  }

  for (const rule of present) {
    if (!registered.includes(rule)) {
      failures.push(
        `${rulesDir}/${rule}.ts is present but not registered in ${indexFile}, so it lints nothing. ` +
          `Register it, or delete the file — dead rule source reads like a fence that is up.`,
      );
    }
  }

  for (const rule of registered) {
    if (!present.includes(rule)) {
      failures.push(`${indexFile} registers "${rule}", which has no module in ${rulesDir}.`);
      continue;
    }

    rules.push({ plugin, rule, rulesDir });
  }
}

for (const id of Object.keys(PROBES)) {
  if (!rules.some(({ plugin, rule }) => `${plugin}/${rule}` === id)) {
    failures.push(
      `PROBES holds "${id}", which no plugin registers. A probe for an absent rule reports nothing and ` +
        `would read as a passing drive.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The fixtures: does each rule still match what it claims to? Run in this
// process, so `RuleTester#run` can hand over the `invalid` cases it was given.
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<Record<string, unknown>>>} invalid cases, keyed `<plugin>/<rule>` */
const capturedInvalid = new Map();

/** @type {string | null} */
let capturing = null;

/** @type {string[]} */
let caseFailures = [];

let casesRun = 0;

// oxlint-disable-next-line typescript/unbound-method -- the patch below replaces the prototype method and calls the original with `.call(this, …)`, so it must hold the unbound function.
const runFixtures = RuleTester.prototype.run;

RuleTester.prototype.run = function captureInvalidCases(ruleName, rule, tests) {
  if (capturing !== null) {
    const cases = capturedInvalid.get(capturing) ?? [];

    for (const test of tests.invalid) cases.push({ ...test });
    capturedInvalid.set(capturing, cases);
  }

  return runFixtures.call(this, ruleName, rule, tests);
};

// RuleTester's own `it` throws on the first failing case. This one runs every
// case and keeps each failure, so one broken case does not hide the rest.
RuleTester.it = (name, method) => {
  casesRun += 1;

  try {
    method();
  } catch (error) {
    caseFailures.push(`${name}: ${errorText(error)}`);
  }
};

let suitesRun = 0;

for (const { plugin, rule, rulesDir } of rules) {
  const testFile = join(rulesDir, `${rule}.rule-test.ts`);

  if (!existsSync(resolve(ROOT, testFile))) continue;
  capturing = `${plugin}/${rule}`;
  caseFailures = [];

  const casesBefore = casesRun;

  try {
    await import(pathToFileURL(resolve(ROOT, testFile)).href);
  } catch (error) {
    caseFailures.push(`the file did not load: ${errorText(error)}`);
  }

  capturing = null;

  // A fixture file that runs no case passes vacuously, which is the silence
  // this gate exists to refuse.
  if (casesRun === casesBefore) caseFailures.push("it ran no RuleTester case");

  if (caseFailures.length > 0) {
    failures.push(`${testFile} failed:\n    ${caseFailures.join("\n    ")}`);
  } else {
    suitesRun += 1;
  }
}

// ---------------------------------------------------------------------------
// The drive: does the ROOT config actually enforce each rule at "error"?
// ---------------------------------------------------------------------------

/** @type {Map<string, string[]>} probe snippets, keyed `<plugin>/<rule>` */
const probes = new Map();

for (const { plugin, rule } of rules) {
  const id = `${plugin}/${rule}`;

  if (Object.hasOwn(PROBES, id)) {
    probes.set(id, [PROBES[id]]);
    continue;
  }

  const drivable = (capturedInvalid.get(id) ?? []).filter((test) =>
    Object.keys(test).every((key) => DRIVABLE_CASE_KEYS.has(key)),
  );

  if (drivable.length === 0) {
    failures.push(
      `"${id}" has no probe: no PROBES entry in ${GATE_FILE}, and no invalid fixture case the root config ` +
        `can reproduce (one with no filename, options, settings, languageOptions or hooks). Nothing proves ` +
        `the root config enables it.`,
    );
    continue;
  }

  probes.set(
    id,
    drivable.map((test) => String(test.code)),
  );
}

const pluginNames = new Set(pluginDirs);

const probeDir = mkdtempSync(join(tmpdir(), "alfred-oxlint-plugins-"));

const driven = [];

let probeFiles = 0;

try {
  for (const [id, snippets] of probes) {
    snippets.forEach((snippet, index) => {
      const stem = `${id.replace("/", "__")}__${index}`;

      writeFileSync(join(probeDir, `${stem}.ts`), snippet);
      probeFiles += 1;
    });
  }

  writeFileSync(join(probeDir, `${CONTROL_NAME}.ts`), CONTROL);

  // oxlint exits non-zero because the probes are meant to fail, so the throw is
  // the expected path; only a missing `stdout` is a real error here.
  let stdout;

  try {
    stdout = execFileSync(
      OXLINT_BIN,
      ["--config", ".oxlintrc.json", "--format", "json", probeDir],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    stdout = capturedStdout(error);
  }

  let report;

  try {
    report = JSON.parse(stdout);
  } catch {
    failures.push(
      `oxlint did not emit a JSON report for the probe directory, so no rule was driven. Output was: ` +
        `${stdout.slice(0, 400) || "(empty)"}`,
    );
    report = { diagnostics: [] };
  }

  /** @type {Map<string, { id: string, severity: string }[]>} probe file stem → plugin reports */
  const reports = new Map();

  for (const diagnostic of report.diagnostics ?? []) {
    const code = /^([a-z0-9-]+)\(([a-z0-9-]+)\)$/.exec(String(diagnostic.code ?? ""));

    if (code === null || !pluginNames.has(code[1])) continue;

    const stem =
      String(diagnostic.filename ?? "")
        .split("/")
        .pop()
        ?.replace(/\.ts$/, "") ?? "";

    const seen = reports.get(stem) ?? [];
    seen.push({ id: `${code[1]}/${code[2]}`, severity: String(diagnostic.severity ?? "") });
    reports.set(stem, seen);
  }

  for (const [id, snippets] of probes) {
    const [plugin, rule] = id.split("/");
    /** @type {number[]} */
    const missed = [];
    /** @type {string[]} */
    const otherRules = [];
    /** @type {string[]} */
    const wrongSeverities = [];

    snippets.forEach((_snippet, index) => {
      const reported = reports.get(`${id.replace("/", "__")}__${index}`) ?? [];
      const own = reported.filter((entry) => entry.id === id);

      if (own.length === 0) {
        missed.push(index);
        otherRules.push(...reported.map((entry) => entry.id));

        return;
      }

      for (const entry of own) {
        if (entry.severity !== "error") wrongSeverities.push(entry.severity);
      }
    });

    if (missed.length > 0) {
      failures.push(
        `The root config did not report ${plugin}(${rule}) on ${missed.length} of ${snippets.length} probe(s) ` +
          `that violate it (probe ${missed.join(", ")}). The rule is present and registered but NOT enforced — ` +
          `check its "${id}" entry in .oxlintrc.json and the "./${PLUGINS_DIR}/${plugin}/index.ts" entry in ` +
          `"jsPlugins".` +
          (otherRules.length > 0
            ? ` (Other plugin rules did fire on them: ${[...new Set(otherRules)].join(", ")}.)`
            : ""),
      );
    } else if (wrongSeverities.length > 0) {
      failures.push(
        `${plugin}(${rule}) reported at "${wrongSeverities[0]}", not "error". Check its "${id}" entry in ` +
          `.oxlintrc.json.`,
      );
    } else {
      driven.push(id);
    }
  }

  const controlHits = reports.get(CONTROL_NAME) ?? [];

  if (controlHits.length > 0) {
    failures.push(
      `The control snippet, which violates none of these rules, was reported by ` +
        `${controlHits.map((entry) => entry.id).join(", ")}. A rule that reports everything would satisfy ` +
        `every probe above, so the drive proves nothing until this is clean.`,
    );
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("The oxlint plugins are not fully wired:\n");

  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

const perPlugin = pluginDirs
  .map((plugin) => `${plugin}: ${rules.filter((entry) => entry.plugin === plugin).length}`)
  .join(", ");

console.log(
  `check-oxlint-plugin: ${rules.length} rule(s) in ${pluginDirs.length} plugin(s) (${perPlugin}) — ` +
    `${suitesRun} fixture suite(s) pass (${casesRun} case(s)), all registered, ${driven.length} driven at ` +
    `"error" through .oxlintrc.json over ${probeFiles} probe file(s) (control snippet clean).`,
);
