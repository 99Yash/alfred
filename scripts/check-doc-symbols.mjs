/**
 * Fails when a doc names a code symbol that no longer exists.
 *
 * The reference docs and the per-package agent guides are the tier an agent
 * reads as current behavior, so a stale identifier there is worse than no doc
 * at all: it teaches a name that will not compile. This check makes that class
 * of drift a build failure instead of a discovery.
 *
 * Scope is deliberately narrow to stay signal-dense:
 *   - Inline code spans only. Fenced blocks carry intentional counter-examples
 *     (code-style.md shows the hand-rolled shape it is arguing against).
 *   - Code-shaped identifiers only — an internal capital or an underscore.
 *     Prose in backticks ("`overlapped`") is not a symbol claim.
 *   - Dotted names are skipped: tool names like `gmail.read_message` are
 *     composed from const halves and never appear as one literal.
 *   - Names edged with an underscore are skipped: `VITE_` / `prun_` are prefix
 *     patterns, and `_dmarc` / `_bimi` are DNS labels, not repo symbols.
 *   - Regions marked as not-yet-built are skipped. The check's premise is that
 *     a doc claims to describe *current code*; a section or entry labelled
 *     "designed, not built" or "(deferred)" makes no such claim, so naming its
 *     future symbols is honest rather than stale. Marking is how a design gets
 *     to keep its vocabulary without asserting the code exists — see
 *     CONTEXT.md's Meeting prep and Attachments sections.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorkspaces } from "./workspaces.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARCH_ROOTS = ["packages", "apps", "scripts"];
const SEARCH_EXTENSIONS = /\.(ts|tsx|mjs|js|json|sql|yaml|yml)$/;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

const { workspaces, failures: workspaceFailures } = listWorkspaces(ROOT);

/** Docs that claim to describe current code. */
const DOC_FILES = [
  ...referenceDocs(),
  "CLAUDE.md",
  "CONTEXT.md",
  "docs/README.md",
  ...packageGuides(workspaces),
];

/**
 * Names that are legitimately absent from this tree. Every entry needs a
 * reason — if you cannot write one, the doc is wrong, not the check.
 */
const ALLOWED = new Map([
  // Upstream API names this repo documents but does not itself declare.
  ["beforeHandle", "Elysia lifecycle hook name"],
  ["afterHandle", "Elysia lifecycle hook name"],
  ["mapResponse", "Elysia lifecycle hook name"],
  ["afterResponse", "Elysia lifecycle hook name"],
  ["preloadError", "Vite's own `vite:preloadError` event name"],
  ["JobsOptions", "BullMQ's exported type, referenced but not re-declared here"],
  ["webhook_secret", "field in GitHub's app-manifest conversion response"],
  ["in_progress", "example of a provider's own native state string"],
  // Metavariables and analogies in review/style examples.
  ["DocArg", "illustrative shape in a code-style example"],
  ["fooSchema", "metavariable in a code-style example"],
  ["rowToX", "metavariable standing for rowToFact / rowToEntity / rowToBriefing"],
  ["usr_abc123", "placeholder id in a database-convention example"],
  ["uint64_t", "C type used in a review analogy"],
  ["z80_desc", "foreign-codebase name used in a review analogy"],
  ["searchGithub", "hypothetical name in a structural-review example"],
  ["notionError", "hypothetical local variable in a review example"],
  ["nextRunAtIso", "placeholder inside a BullMQ jobId template, not an exported name"],
  ["some_provider", "metavariable in an integration-activity `providerKind` example"],
  ["suggestedMessages", "dimension.dev's entity name, cited as the shape Alfred did NOT copy"],
  [
    "SENSITIVE_LOG_PATHS",
    "named in CONTEXT.md precisely to record that ADR-0038's central redaction const was never built",
  ],
]);

function referenceDocs() {
  const dir = join(ROOT, "docs/reference");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/reference/${name}`);
}

/**
 * The per-workspace guide of every declared workspace.
 *
 * Keyed on the directory and never on the manifest's `name`: a guide file is prose
 * about a tree, so a workspace whose manifest is nameless or unreadable still has a
 * guide that claims to describe current code.
 */
function packageGuides(declared) {
  const guides = [];
  for (const workspace of declared) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const candidate = join(ROOT, workspace.dir, name);
      if (!isFile(candidate)) continue;
      guides.push(relative(ROOT, candidate));
      break; // AGENTS.md is usually a symlink to CLAUDE.md; one read is enough.
    }
  }
  return guides;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Strip fenced blocks so their illustrative names never reach the scan. */
function withoutFencedBlocks(markdown) {
  return markdown.replace(/^```[\s\S]*?^```/gm, "");
}

/** A section banner: `> **Designed, not built.**` under a heading. */
const DESIGN_SECTION_BANNER = /^>\s*\*\*Designed, not built\.\*\*/m;

/** An entry whose own bold lead admits it is unbuilt: `**Foo (deferred).**` */
const DESIGN_ENTRY_LEAD = /^\*\*[^*]*\((?:deferred|designed, not built)\)\.?\*\*/i;

/**
 * Drop the regions that do not claim to describe current code: whole `##`
 * sections carrying the design banner, and individual entries whose lead marks
 * them deferred. Everything else still has to resolve.
 */
function withoutDesignRegions(markdown) {
  const kept = [];
  for (const section of markdown.split(/^(?=## )/m)) {
    if (DESIGN_SECTION_BANNER.test(section)) continue;
    const paragraphs = section
      .split(/\n{2,}/)
      .filter((paragraph) => !DESIGN_ENTRY_LEAD.test(paragraph.trimStart()));
    kept.push(paragraphs.join("\n\n"));
  }
  return kept.join("\n\n");
}

function isCodeShaped(token) {
  if (token.length < 5) return false;
  if (token.includes(".")) return false;
  if (token.startsWith("_") || token.endsWith("_")) return false;
  const hasInternalCapital = /[a-z][A-Z]/.test(token);
  const hasUnderscore = token.includes("_");
  return hasInternalCapital || hasUnderscore;
}

function symbolsIn(markdown) {
  const symbols = new Set();
  const scannable = withoutDesignRegions(withoutFencedBlocks(markdown));
  for (const match of scannable.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1] ?? "";
    for (const token of span.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = token[0];
      if (isCodeShaped(name) && !ALLOWED.has(name)) symbols.add(name);
    }
  }
  return symbols;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (SEARCH_EXTENSIONS.test(entry.name)) yield path;
  }
}

/** One pass over the tree; a per-symbol grep would be O(symbols x files). */
function collectDefinedNames() {
  const defined = new Set();
  for (const searchRoot of SEARCH_ROOTS) {
    const dir = join(ROOT, searchRoot);
    if (!isFile(dir) && !statSync(dir).isDirectory()) continue;
    for (const file of walk(dir)) {
      const source = readFileSync(file, "utf8");
      for (const token of source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        defined.add(token[0]);
      }
    }
  }
  return defined;
}

const defined = collectDefinedNames();
const missing = [];

for (const doc of DOC_FILES) {
  const path = join(ROOT, doc);
  if (!isFile(path)) continue;
  for (const symbol of symbolsIn(readFileSync(path, "utf8"))) {
    if (!defined.has(symbol)) missing.push({ doc, symbol });
  }
}

// A refused enumeration means the per-workspace guides were collected from a
// shorter list of workspaces than the repository declares, so "every named symbol
// resolves" would be a statement about docs this run never opened.
if (workspaceFailures.length > 0) {
  console.error("The workspace enumeration did not resolve, so some package guides went unread:\n");
  for (const failure of workspaceFailures) console.error(`- ${failure}`);
  console.error("");
}

if (missing.length > 0) {
  console.error("Docs name symbols that do not exist in packages/apps/scripts:\n");
  for (const { doc, symbol } of missing) {
    console.error(`- ${doc}: \`${symbol}\``);
  }
  console.error(
    "\nFix the doc to match the code, or add the name to ALLOWED in" +
      "\nscripts/check-doc-symbols.mjs with a reason if it is genuinely external" +
      "\nor illustrative.",
  );
}

if (missing.length > 0 || workspaceFailures.length > 0) process.exit(1);

console.log(
  `check-doc-symbols: ${DOC_FILES.length} docs scanned, every named symbol resolves.`,
);
