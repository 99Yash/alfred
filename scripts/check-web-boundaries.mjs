import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_SRC = join(ROOT, "apps/web/src");
const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  "@alfred/api",
  "@alfred/auth",
  "@alfred/db",
  "@alfred/env",
  "@alfred/ai",
]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

function packageName(specifier) {
  if (!specifier.startsWith("@alfred/")) return null;
  const [scope, pkg] = specifier.split("/");
  return pkg ? `${scope}/${pkg}` : null;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findViolations(file) {
  const source = readFileSync(file, "utf8");
  const violations = [];
  const staticImport = /\b(import|export)\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  const sideEffectImport = /\bimport\s*["']([^"']+)["']/g;
  const dynamicImport = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(staticImport)) {
    const clause = match[2] ?? "";
    const specifier = match[3] ?? "";
    const pkg = packageName(specifier);
    if (!pkg || !FORBIDDEN_RUNTIME_PACKAGES.has(pkg) || !hasRuntimeBinding(clause)) continue;
    violations.push({
      line: lineNumber(source, match.index ?? 0),
      specifier,
    });
  }

  for (const pattern of [sideEffectImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? "";
      const pkg = packageName(specifier);
      if (!pkg || !FORBIDDEN_RUNTIME_PACKAGES.has(pkg)) continue;
      violations.push({
        line: lineNumber(source, match.index ?? 0),
        specifier,
      });
    }
  }
  return violations;
}

function hasRuntimeBinding(clause) {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return false;

  const namedOnly = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!namedOnly) return true;

  const specifiers = namedOnly[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return specifiers.some((specifier) => !specifier.startsWith("type "));
}

const violations = [];
for (const file of walk(WEB_SRC)) {
  for (const violation of findViolations(file)) {
    violations.push({
      file: relative(ROOT, file),
      ...violation,
    });
  }
}

if (violations.length > 0) {
  console.error("Forbidden runtime imports in apps/web:");
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} imports ${v.specifier}`);
  }
  console.error(
    "Use type-only imports where allowed, or move shared runtime code to @alfred/contracts/@alfred/schemas/@alfred/sync.",
  );
  process.exit(1);
}
