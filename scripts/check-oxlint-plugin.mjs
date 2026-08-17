// Fails when a vendored anti-slop rule is untested, unregistered, or registered
// but not actually enforced by the root config.
//
// `scripts/oxlint/anti-slop/` is vendored third-party rule source (see its
// README). Nothing else in this repo reaches it: no package's `check-types`
// covers `scripts/`, `pnpm -r test` cannot see it because `scripts/` is not a
// workspace, and a rule that is present but never registered lints nothing while
// looking exactly like a rule that works. This gate closes all three gaps.
//
// The enablement claim is the one worth explaining. It is NOT read out of the
// config: `oxlint --print-config` omits every JS-plugin rule from its resolved
// `rules` object — measured, and true of `tailwindcss/*` here too — so a gate
// built on `resolvedOxlintConfig` would parse a config in which these rules do
// not appear and pass while reading nothing. Instead each rule is DRIVEN: the
// gate writes a snippet that violates it to a temp directory, lints that
// directory through `--config .oxlintrc.json`, and demands the rule report it at
// `error`. That proves registration, enablement and severity end to end, and it
// is the claim `pnpm lint` on a clean tree cannot make.
//
// A clean tree is why the drive exists. All three rules had zero violations when
// they were adopted, so `pnpm lint` is silent whether they work or are switched
// off entirely.
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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join("scripts", "oxlint", "anti-slop");
const RULES_DIR = join(PLUGIN_DIR, "rules");
const INDEX_FILE = join(PLUGIN_DIR, "index.ts");
const GATE_FILE = join("scripts", "check-oxlint-plugin.mjs");
const OXLINT_BIN = resolve(ROOT, "node_modules", ".bin", "oxlint");

// Explicit, not scraped out of the upstream `.test.ts` fixtures: the drive below
// asserts a rule fires through the ROOT config, which is a different claim from
// the one RuleTester makes, and a regex over a fixture array would turn a rule
// whose invalid case is a template literal into a silent skip.
//
// Each snippet must violate exactly its own rule. Keep the shape notes — the
// `vi` one is a trap that already produced a probe that passed for the wrong
// reason.
// Each entry maps to { snippet, severity }. The severity must match .oxlintrc.json:
// "error" for ratchet rules, "warn" for paydown rules.
const PROBES = {
  // `vi` is deliberately left UNDECLARED. no-module-mocking resolves the binding
  // and ignores a local one (upstream treats `function f(jest: {mock(): void})`
  // as valid), so a `declare const vi` probe passes without the rule doing
  // anything.
  "no-module-mocking": { snippet: `vi.mock("./user-store");\n`, severity: "error" },
  "no-reflect-apply": { snippet: `export const value = Reflect.apply(operation, owner, args);\n`, severity: "error" },
  "no-widen-then-assert": {
    snippet:
      `const source = { id: "second" };\n` +
      `const widened: unknown = source;\n` +
      `export const parsed = widened as { readonly id: string };\n`,
    severity: "error",
  },
  "no-chained-type-assertions": { snippet: `export const user = input as object as User;\n`, severity: "error" },
  "no-known-value-widening": {
    snippet:
      `type Handler = () => void;\n` +
      `const handlers: Record<string, Handler> = { start: startHandler };\n`,
    severity: "warn",
  },
  "no-object-parameters": { snippet: `export function save(value: object) {}\n`, severity: "error" },
  "no-runtime-typeof": { snippet: `export const isString = typeof input === "string";\n`, severity: "warn" },
  "no-shape-in-symbol-names": { snippet: `export interface UserShape { id: string }\n`, severity: "warn" },
  "no-unknown-returns": { snippet: `export function loadUser(): unknown { return input; }\n`, severity: "warn" },
  "no-unknown-type-aliases": { snippet: `export type ExternalValue = unknown;\n`, severity: "warn" },
  "no-unsafe-dictionary-type": { snippet: `export type Metadata = Record<string, unknown>;\n`, severity: "warn" },
  "require-safety-comment-for-type-assertion": { snippet: `export const userId = value as UserId;\n`, severity: "warn" },
};

// The control. Linted alongside the probes so "every probe reported its rule"
// cannot be satisfied by a rule that reports everything.
const CONTROL = `export const ok = { id: "second" };\n`;
const CONTROL_NAME = "control";

const failures = [];

/**
 * The stdout a failed `execFileSync` captured before it threw. Both drives below
 * read output from a process they EXPECT to exit non-zero — the fixtures print
 * their assertion on failure, and oxlint exits 1 because the probes are supposed
 * to be rejected — so the throw is the normal path and its `stdout` is the result.
 *
 * @param {unknown} error
 * @returns {string}
 */
function capturedStdout(error) {
  const stdout = /** @type {{ stdout?: unknown }} */ (error).stdout;
  return typeof stdout === "string" ? stdout : "";
}

// ---------------------------------------------------------------------------
// Discovery: what is vendored, and is each piece tested?
// ---------------------------------------------------------------------------

let entries;
try {
  entries = readdirSync(resolve(ROOT, RULES_DIR));
} catch (error) {
  console.error(
    `${RULES_DIR} could not be read (${error instanceof Error ? error.message : String(error)}). ` +
      `Without it this gate would check nothing.`,
  );
  process.exit(1);
}

const ruleModules = entries.filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".rule-test.ts"),
);
const testModules = new Set(entries.filter((name) => name.endsWith(".rule-test.ts")));
const vendored = ruleModules.map((name) => name.slice(0, -".ts".length)).sort();

// A zero count is a failure, not a pass: it means the walk found no rule and the
// gate compared nothing.
if (vendored.length === 0) {
  console.error(
    `${RULES_DIR} holds no rule module. A zero here means the walk is broken, not that the plugin is clean.`,
  );
  process.exit(1);
}

for (const rule of vendored) {
  if (!testModules.has(`${rule}.rule-test.ts`)) {
    failures.push(
      `${RULES_DIR}/${rule}.ts has no sibling ${rule}.rule-test.ts. Vendor the upstream fixtures with the rule; ` +
        `an untested rule that stops matching fails open and the tree stays green.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registration: is every vendored rule wired into the plugin, and vice versa?
// ---------------------------------------------------------------------------

const indexSource = readFileSync(resolve(ROOT, INDEX_FILE), "utf8");
const registered = [...indexSource.matchAll(/^\s*"([a-z0-9-]+)":\s*[A-Za-z][A-Za-z0-9]*Rule,$/gm)]
  .map((match) => match[1])
  .sort();

if (registered.length === 0) {
  console.error(
    `${INDEX_FILE} registers no rule, or its \`rules\` entries no longer match the shape this gate reads. ` +
      `Either way the plugin enforces nothing.`,
  );
  process.exit(1);
}

for (const rule of vendored) {
  if (!registered.includes(rule)) {
    failures.push(
      `${RULES_DIR}/${rule}.ts is vendored but not registered in ${INDEX_FILE}, so it lints nothing. ` +
        `Register it, or delete the file — dead vendored source reads like a fence that is up.`,
    );
  }
}
for (const rule of registered) {
  if (!vendored.includes(rule)) {
    failures.push(`${INDEX_FILE} registers "${rule}", which has no module in ${RULES_DIR}.`);
  }
}

for (const rule of registered) {
  if (!Object.hasOwn(PROBES, rule)) {
    failures.push(
      `"${rule}" is registered but has no probe in ${GATE_FILE}, so nothing here proves the root config ` +
        `enables it. Add a snippet that violates it to PROBES.`,
    );
  }
}
for (const rule of Object.keys(PROBES)) {
  if (!registered.includes(rule)) {
    failures.push(
      `PROBES holds "${rule}", which ${INDEX_FILE} no longer registers. A probe for an absent rule reports ` +
        `nothing and would read as a passing drive.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The upstream fixtures: does each rule still match what it claims to?
// ---------------------------------------------------------------------------

// `--experimental-strip-types` is passed explicitly rather than relying on bare
// `node file.ts`: type stripping is unflagged only from Node 22.18, and this
// repo's `engines` field admits 22.12. On a newer Node the flag is a no-op.
let testsRun = 0;
for (const rule of vendored) {
  if (!testModules.has(`${rule}.rule-test.ts`)) continue;
  const testFile = join(RULES_DIR, `${rule}.rule-test.ts`);
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", testFile], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    testsRun += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${testFile} failed:\n${`${message}\n${capturedStdout(error)}`.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// The drive: does the ROOT config actually enforce each rule, at its expected
// severity? Ratchet rules must report at "error"; paydown rules at "warn".
// ---------------------------------------------------------------------------

const probeDir = mkdtempSync(join(tmpdir(), "alfred-oxlint-anti-slop-"));
const driven = [];
try {
  for (const [rule, { snippet }] of Object.entries(PROBES)) {
    writeFileSync(join(probeDir, `${rule}.ts`), snippet);
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

  const antiSlop = new Map();
  for (const diagnostic of report.diagnostics ?? []) {
    const code = /^anti-slop\(([a-z0-9-]+)\)$/.exec(String(diagnostic.code ?? ""));
    if (code === null) continue;
    const file =
      String(diagnostic.filename ?? "")
        .split("/")
        .pop()
        ?.replace(/\.ts$/, "") ?? "";
    const seen = antiSlop.get(file) ?? [];
    seen.push({ rule: code[1], severity: String(diagnostic.severity ?? "") });
    antiSlop.set(file, seen);
  }

  for (const rule of Object.keys(PROBES)) {
    const reported = antiSlop.get(rule) ?? [];
    const own = reported.filter((entry) => entry.rule === rule);
    if (own.length === 0) {
      failures.push(
        `The root config did not report anti-slop(${rule}) on a snippet that violates it. The rule is ` +
          `vendored and registered but NOT enforced — check its "anti-slop/${rule}" entry in .oxlintrc.json ` +
          `and the "./scripts/oxlint/anti-slop/index.ts" entry in "jsPlugins".` +
          (reported.length > 0
            ? ` (Other anti-slop rules did fire on it: ${reported.map((e) => e.rule).join(", ")}.)`
            : ""),
      );
      continue;
    }
    const expectedSeverity = PROBES[rule].severity;
    const jsonSeverity = expectedSeverity === "error" ? "error" : "warning";
    const wrongSeverity = own.filter((entry) => entry.severity !== jsonSeverity);
    if (wrongSeverity.length > 0) {
      failures.push(
        `anti-slop(${rule}) reported at "${wrongSeverity[0].severity}", not "${jsonSeverity}". ` +
          `Check its "anti-slop/${rule}" entry in .oxlintrc.json.`,
      );
      continue;
    }
    driven.push(rule);
  }

  const controlHits = antiSlop.get(CONTROL_NAME) ?? [];
  if (controlHits.length > 0) {
    failures.push(
      `The control snippet, which violates none of these rules, was reported by ` +
        `${controlHits.map((entry) => `anti-slop(${entry.rule})`).join(", ")}. A rule that reports everything ` +
        `would satisfy every probe above, so the drive proves nothing until this is clean.`,
    );
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("The vendored anti-slop plugin is not fully wired:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

const errorCount = driven.filter((r) => PROBES[r].severity === "error").length;
const warnCount = driven.filter((r) => PROBES[r].severity === "warn").length;
console.log(
  `check-oxlint-plugin: ${vendored.length} vendored rule(s) — ${testsRun} upstream fixture suite(s) pass, ` +
    `all registered in ${INDEX_FILE}, ${errorCount} at "error" + ${warnCount} at "warn" through .oxlintrc.json ` +
    `(control snippet clean).`,
);
