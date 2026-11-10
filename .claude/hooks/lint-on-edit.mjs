#!/usr/bin/env node
// Edit-time half of `pnpm lint` (the root `.oxlintrc.json`).
//
// `helper-hints.mjs` reads the regex table in scripts/consolidation-rules.mjs
// before an edit lands. A rule that needs the syntax tree lives in an oxlint JS
// plugin instead (`scripts/oxlint/alfred/`, `scripts/oxlint/anti-slop/`), and a
// regex hook cannot run it. This hook runs the repo's own oxlint, with the root
// config, on the one file an edit just wrote, so an AST rule speaks at the
// moment of the mistake too.
//
// It reports every rule the config fires, not only `alfred/*`. Every rule in
// `.oxlintrc.json` is at `error` and the tree is at zero, so each diagnostic
// on the file is one `pnpm lint` will reject. A plugin filter would hide the
// anti-slop rules, which are just as silent at edit time. A rule added to the
// config is reported here with no table to keep in step.
//
// It first applies the fixes that need no judgment (`scripts/autofix.mjs`: the
// safe `oxlint --fix` fixes, then `oxfmt --write`), so a formatting or fixable
// lint error never reaches `pnpm check`. It then reports what remains, from the
// same lint run. Line numbers are from before `oxfmt` ran.
//
// Advisory only. It runs after the write, so it cannot block it, and it always
// exits 0. It prints nothing when the file is clean, when the file is not
// `.ts`/`.tsx` under the repo, when the file does not parse yet, or when oxlint
// is missing, slow, or prints output it cannot read.
//
// Reads PostToolUse JSON on stdin, prints hookSpecificOutput JSON, exits 0.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { autofix } from "../../scripts/autofix.mjs";

// Advisory: a bug in this file must not surface as a hook error on every edit.
process.on("uncaughtException", () => process.exit(0));

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const OXLINT = join(ROOT, "node_modules", ".bin", "oxlint");

const CONFIG = join(ROOT, ".oxlintrc.json");

// The root config sets `options.typeAware`, so this run includes the type-aware
// rules (no-floating-promises, no-misused-promises, …) with no extra flag: tsgolint
// builds the program for the one file's tsconfig. Measured at 0.4–0.85s per file
// with the JS plugins loaded. Past this, give up silently rather than stall the
// session.
const TIMEOUT_MS = 5_000;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let payload = {};

try {
  payload = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}

const filePath = String(payload.tool_input?.file_path ?? "");

if (!filePath.startsWith(`${ROOT}/`) || !existsSync(filePath)) process.exit(0);

const rel = filePath.slice(ROOT.length + 1);

// Any file in the `pnpm format` scope gets formatted, not only `.ts`/`.tsx`.
if (!/\.tsx?$/.test(filePath) || !existsSync(OXLINT) || !existsSync(CONFIG)) {
  autofix(ROOT, [rel], { timeoutMs: TIMEOUT_MS });
  process.exit(0);
}

// The same flags as `pnpm lint`, from the root, so `overrides` globs and
// `ignorePatterns` resolve as they do there.
const run = autofix(ROOT, [rel], {
  timeoutMs: TIMEOUT_MS,
  lintArgs: ["--report-unused-disable-directives-severity=error", "--format", "json"],
}).lint;

if (!run) process.exit(0);

// `run.error` covers a missing binary and the timeout. Empty output means oxlint
// printed no report, so there is nothing to say.
if (run.error || !run.stdout) process.exit(0);

let report;

try {
  report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));
} catch {
  process.exit(0);
}

// A diagnostic with no rule `code` is a parse failure. A half-written file has one, and
// the compiler already reports it, so it is not a lint finding.
const diagnostics = (Array.isArray(report?.diagnostics) ? report.diagnostics : []).filter(
  (d) => d?.code,
);

if (diagnostics.length === 0) process.exit(0);

/** `alfred(sha256-over-json-stringify)` is spelled `alfred/sha256-over-json-stringify` in config and disable comments. */
const ruleId = (code) => String(code ?? "").replace(/^([\w-]+)\((.+)\)$/, "$1/$2");

const lines = diagnostics.map((d) => {
  const at = d.labels?.[0]?.span?.line;

  return `- \`${ruleId(d.code)}\`${at ? ` (line ${at})` : ""}: ${String(d.message ?? "").trim()}`;
});

const body = [
  `# \`pnpm lint\` will reject \`${rel}\``,
  `oxlint with the root \`.oxlintrc.json\` reports ${diagnostics.length} diagnostic(s) on the file you just wrote. Fix them, or add \`// oxlint-disable-next-line <rule> -- <reason>\` if the exception is deliberate.`,
  ``,
  ...lines,
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: body },
  }),
);
