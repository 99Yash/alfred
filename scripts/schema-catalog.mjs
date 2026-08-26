// A discovery aid for runtime validators: where do this repo's zod schemas
// live, and which declared shapes look identical under different names?
//
// The repo's answer to "where does a schema go" is consumer need, not file
// type - cross-boundary shapes live in @alfred/contracts domain files, synced
// read models in @alfred/sync/src/schemas.ts, provider wire shapes next to
// their client, and lookup-by-name surfaces in registries like
// TOOL_INPUT_SCHEMAS. That ownership is deliberate (see
// docs/reference/schemas.md); what it never provided was a front door. This
// script is that front door, so nobody has to read every module to answer
// "does a parser for this shape already exist?".
//
// Detection is deliberately conservative: a definition is a `const NAME =
// z.<method>(...)` binding (annotation allowed), and a duplicate is an
// EXACT normalized match of two z.object bodies. Both choices trade recall
// for near-zero false positives - this tool's job is to send a reader to the
// right file with confidence, not to guess.
//
// Usage:
//   node scripts/schema-catalog.mjs                    # catalog by package
//   node scripts/schema-catalog.mjs --package=ai      # one package
//   node scripts/schema-catalog.mjs --dupes           # identical-shape groups
//   node scripts/schema-catalog.mjs --selftest        # fixtures only

import { readFileSync } from "node:fs";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { schemaCatalogSelfTestFailures } from "./schema-catalog.selftest.mjs";

const SCAN_PATTERNS = ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"];

/** A direct zod construction bound to a name. Annotation before `=` is allowed. */
const DIRECT_DEF =
  /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+(\w+)[ \t]*(?::[^=\n]+)?=[ \t]*\n?[ \t]*z\.(\w+)/gm;

/**
 * A composition: a new binding built off a known schema base via a chain
 * method. The base must itself be a known schema name or carry the Schema
 * suffix, so unrelated fluent chains (sql, builder, promise) stay out.
 */
const COMPOSE_DEF =
  /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+(\w+)[ \t]*(?::[^=\n]+)?=[ \t]*\n?[ \t]*(\w+)\.(?:extend|omit|pick|merge|partial|required|deepPartial|refine|superRefine)\b/gm;

/** Strip comments and collapse whitespace so textually-equal bodies compare equal. */
function normalizeBody(body) {
  return body
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * From the index of an opening `{`, walk to its matching `}` while skipping
 * string/template/comment spans, so braces inside literals cannot unbalance
 * the count. Returns null when the file ends mid-body (truncated extraction,
 * never a match).
 */
function balancedBraces(text, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}

function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    // A template literal may interpolate; treat ${ ... } as opaque by jumping
    // to its closing brace - nesting inside stays out of scope on purpose.
    if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
      const close = text.indexOf("}", i);
      if (close === -1) return text.length;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return text.length;
}

/** Collect schema bindings declared in one file. */
export function scanFile(source) {
  const found = [];
  const known = () => new Set(found.map((entry) => entry.name));

  for (const [, name, ctor] of source.matchAll(DIRECT_DEF)) {
    found.push({ name, kind: `z.${ctor}`, exported: isExported(source, name) });
  }

  // Compositions resolve against bases found above (same pass list, so a base
  // declared later in the file still counts once both passes have run).
  const bases = known();
  for (const [, name, base] of source.matchAll(COMPOSE_DEF)) {
    const isSchemaBase = bases.has(base) || /Schema$/.test(base);
    if (!isSchemaBase) continue;
    found.push({
      name,
      kind: `${base}.extend()+`,
      exported: isExported(source, name),
    });
  }

  // Attach an object-body signature where the constructor call opens one, so
  // the dupe mode has material without re-parsing.
  for (const entry of found) {
    entry.signature = objectSignature(source, entry.name);
  }
  return found;
}

function isExported(source, name) {
  const re = new RegExp(`export[ \\t\\n]+(?:const|let|var)[ \\t]+${name}\\b`);
  return re.test(source);
}

/**
 * Normalized body of the first `z.object({ ... })` reachable from the
 * declaration of `name`, or null when there isn't one cleanly.
 */
function objectSignature(source, name) {
  const decl = new RegExp(
    `(?:export[ \\t\\n]+)?(?:const|let|var)[ \\t]+${name}\\b[^=]*=[ \\t\\n]*z\\.object\\(`,
  );
  const match = decl.exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index + match[0].length - 1);
  if (open === -1) return null;
  const close = balancedBraces(source, open);
  if (close === null) return null;
  const body = normalizeBody(source.slice(open + 1, close));
  return body.length > 0 ? body : null;
}

/** Scan every tracked src file; returns [{ pkg, file, defs }]. */
export function scanRepo(cwd = process.cwd()) {
  const files = listGitSourceFiles(SCAN_PATTERNS, cwd);
  const results = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const defs = scanFile(source);
    if (defs.length === 0) continue;
    const pkg = file.split("/")[1];
    results.push({ pkg, file, defs });
  }
  return results;
}

/** Group signatures shared by two or more distinct names. */
export function findDupes(repoScan) {
  const bySignature = new Map();
  for (const { pkg, file, defs } of repoScan) {
    for (const def of defs) {
      if (!def.signature) continue;
      const key = `${pkg}/${def.signature}`;
      const list = bySignature.get(key) ?? [];
      list.push(`${file}  ${def.name}`);
      bySignature.set(key, list);
    }
  }
  return [...bySignature.entries()]
    .filter(([, list]) => list.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
}

function printCatalog(repoScan, pkgFilter) {
  const packages = new Map();
  for (const { pkg, file, defs } of repoScan) {
    if (pkgFilter && pkg !== pkgFilter) continue;
    const files = packages.get(pkg) ?? [];
    files.push([file, defs]);
    packages.set(pkg, files);
  }
  if (packages.size === 0) {
    console.log(`no schemas found${pkgFilter ? ` in package '${pkgFilter}'` : ""}.`);
    return;
  }
  let total = 0;
  for (const [pkg, files] of [...packages].sort()) {
    const count = files.reduce((sum, [, defs]) => sum + defs.length, 0);
    total += count;
    console.log(`\n@alfred/${pkg}  (${count})`);
    for (const [file, defs] of files.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${file}`);
      for (const def of defs.sort((a, b) => a.name.localeCompare(b.name))) {
        const mark = def.exported ? "" : "(local)";
        console.log(`    ${mark.padEnd(7)}${def.name}`);
      }
    }
  }
  console.log(`\ntotal: ${total} schema binding(s)`);
}

function printDupes(dupes) {
  if (dupes.length === 0) {
    console.log("no identical object shapes under different names.");
    return;
  }
  console.log(`${dupes.length} duplicated shape group(s):\n`);
  for (const [signature, sites] of dupes) {
    console.log(sites.map((site) => `  ${site}`).join("\n"));
    console.log(`  shape: ${signature.slice(0, 140)}${signature.length > 140 ? "..." : ""}\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    const failures = schemaCatalogSelfTestFailures();
    if (failures.length > 0) {
      console.error("schema-catalog self-test failed:\n");
      for (const failure of failures) console.error(`  ${failure}`);
      process.exit(1);
    }
    console.log("schema-catalog: self-test ok.");
    return;
  }

  const pkgArg = args.find((arg) => arg.startsWith("--package="));
  const pkgFilter = pkgArg ? pkgArg.split("=")[1] : null;

  const repoScan = scanRepo();

  if (args.includes("--dupes")) {
    printDupes(findDupes(repoScan));
    return;
  }

  printCatalog(repoScan, pkgFilter);
}

main();
