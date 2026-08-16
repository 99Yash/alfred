// The rule behind `pnpm check:prose-locators`: every backticked repo-relative
// path and every `@alfred/*` specifier in the repo's prose resolves to something
// that exists.
//
// The `exports` map gate catches a subpath whose target no file covers, but it
// cannot catch prose. ADR-0089 renamed the API packages by ownership and the
// package `@alfred/api` died; its name and its old paths stayed in comments and
// docs, and a doc comment that says a module "lives in `@alfred/api`" stayed
// true-looking to every gate in `pnpm check`. This is the gate that makes the
// next stale locator a build failure.
//
// A span is asserted only when it is a concrete claim:
//   - `@alfred/<pkg>` bare names a declared workspace package (identity, not an
//     import), and passes when that package exists;
//   - `@alfred/<pkg>/<sub>` names a subpath the package's `exports` map
//     publishes, using the same key semantics as `restrictedSpecifierFailures`;
//   - a repo-relative path names a file or directory git lists.
//
// Structural exemptions, so the check reads honest prose as honest:
//   - placeholder spans (a `<`/`>`/brace/`*`/`$`/`~`/ellipsis is a pattern, not
//     a name);
//   - spans whose enclosing sentence asserts the locator's own absence ("there
//     is no", "does not exist", "no longer", "was removed").
//
// Resolution goes through git, never `existsSync`, matching `package-exports.mjs`.
//
// The rules live here so fixtures can drive them; `check-prose-locators.mjs` is
// the enforcing consumer, and `prose-locators.selftest.mjs` is their only
// executor — `scripts/` has no CI test job and no tsconfig names the tree.

import { publishedKey, specifierKind, wildcardTargetPath } from "./package-exports.mjs";

/** A span that carries a placeholder is a pattern, not a name. */
export const PLACEHOLDER = /[<>{}$~…*]|\.\.\./;

/** A sentence that asserts a locator's own absence is not a claim it exists. */
export const NEGATIVE_CONTEXT =
  /there is no|there are no|does not exist|do not exist|never built|no longer|not on|was removed|were removed|was deleted|were deleted|was dropped|removed from|deleted from|now deleted|deletes|deletion of|does not live|does not carry|does not publish|does not ship|used to|lived in|previously|formerly|is dead|is deleted|is removed|are deleted|are removed|is sealed|is blocked|was the home of/i;

/** A section banner: `> **Designed, not built.**` under a heading. */
const DESIGN_SECTION_BANNER = /^>\s*\*\*Designed, not built\.\*\*/m;

/** An entry whose own bold lead admits it is unbuilt: `**Foo (deferred).**` */
const DESIGN_ENTRY_LEAD = /^\*\*[^*]*\((?:deferred|designed, not built)\)\.?\*\*/i;

/** A quote starts a string or template only when it is code, not inside one. */
const QUOTES = "'\"`";

/**
 * The `//` and block comments of one source file, as `{ line, text }`.
 *
 * `line` is the 0-based line where the comment starts; `text` is the comment's
 * full content. Strings and template literals are walked so a `//` or `/*` that
 * sits INSIDE a string is not read as a comment — a locator inside a string
 * literal is code, not prose. A template's `${...}` expression is not descended
 * into, and a regex literal that happens to contain an unescaped `/*` is read as
 * a comment opener; both are rare enough that their cost is a misread span, not
 * a silent miss of every comment after them.
 */
export function commentBlocks(source) {
  const blocks = [];
  const length = source.length;
  let index = 0;
  let line = 0;
  let blockStart = -1;
  let blockLine = 0;

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "\n") line += 1;

    if (blockStart !== -1) {
      if (char === "*" && next === "/") {
        blocks.push({ line: blockLine, text: source.slice(blockStart, index) });
        blockStart = -1;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      const start = index + 2;
      const end = source.indexOf("\n", start);
      blocks.push({ line, text: source.slice(start, end === -1 ? length : end) });
      index = end === -1 ? length : end;
      continue;
    }

    if (char === "/" && next === "*") {
      blockStart = index + 2;
      blockLine = line;
      index += 2;
      continue;
    }

    if (QUOTES.includes(char)) {
      const quote = char;
      index += 1;
      while (index < length) {
        const inside = source[index];
        if (inside === "\\") {
          index += 2;
          continue;
        }
        if (inside === quote) {
          index += 1;
          break;
        }
        if (inside === "\n" && quote !== "`") break;
        if (inside === "\n") line += 1;
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  if (blockStart !== -1) blocks.push({ line: blockLine, text: source.slice(blockStart, length) });
  return blocks;
}

/** The line indexes markdown must not be scanned on: fences and design regions. */
export function excludedMarkdownLines(text) {
  const lines = text.split("\n");
  const excluded = new Set();

  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("```")) {
      inFence = !inFence;
      excluded.add(index);
    } else if (inFence) {
      excluded.add(index);
    }
  }

  const sectionStarts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) sectionStarts.push(index);
  }
  for (let section = 0; section < sectionStarts.length; section += 1) {
    const start = sectionStarts[section];
    const end = section + 1 < sectionStarts.length ? sectionStarts[section + 1] : lines.length;
    const content = lines.slice(start, end).join("\n");
    if (DESIGN_SECTION_BANNER.test(content)) {
      for (let index = start; index < end; index += 1) excluded.add(index);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    const paragraphStart = index === 0 || lines[index - 1].trim() === "";
    if (!paragraphStart) continue;
    if (!DESIGN_ENTRY_LEAD.test(lines[index].trimStart())) continue;
    for (let end = index; end < lines.length && lines[end].trim() !== ""; end += 1) {
      excluded.add(end);
    }
  }

  return excluded;
}

/**
 * The paragraph that contains one line, as text.
 *
 * A blank line ends a paragraph. The window is used only to decide whether the
 * span's sentence asserts the locator's own absence.
 */
export function enclosingParagraph(text, lineIndex) {
  const lines = text.split("\n");
  let start = lineIndex;
  while (start > 0 && lines[start - 1].trim() !== "") start -= 1;
  let end = lineIndex;
  while (end < lines.length - 1 && lines[end + 1].trim() !== "") end += 1;
  return lines.slice(start, end + 1).join("\n");
}

/** The inline backtick spans of one markdown document, with their line numbers. */
export function markdownSpans(text) {
  const lines = text.split("\n");
  const excluded = excludedMarkdownLines(text);
  const spans = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (excluded.has(index)) continue;
    const lineText = lines[index];
    for (const match of lineText.matchAll(/`([^`\n]+)`/g)) {
      spans.push({ span: match[1], line: index + 1, context: enclosingParagraph(text, index) });
    }
  }
  return spans;
}

/** The inline backtick spans inside one comment block. */
export function commentSpans(block) {
  const spans = [];
  const lines = block.text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/`([^`\n]+)`/g)) {
      spans.push({ span: match[1], line: block.line + index + 1, context: block.text });
    }
  }
  return spans;
}

/** Whether the paragraph or block that mentions the span narrates its absence. */
function absenceStatement(context, span) {
  const normalized = context.replace(/\s+/g, " ");
  const sentences = context.split(/(?<=[.!?])\s+/).map((sentence) => sentence.replace(/\s+/g, " "));
  const mentions = sentences.filter((sentence) => sentence.includes(span));
  if (mentions.length === 0) return false;
  if (NEGATIVE_CONTEXT.test(normalized)) return true;
  return mentions.every((sentence) => NEGATIVE_CONTEXT.test(sentence));
}

/**
 * Why one locator does not resolve, or `null` when it resolves or is exempt.
 *
 * `packages` is the workspace-package index from `workspaceExportIndex` (Map of
 * name → `{ dir, keys, problem }`), and `listed` is the full git-listed tree.
 */
export function locatorProblem(span, context, { packages, listed, topLevelDirs }) {
  const trimmed = span.trim();
  if (trimmed === "") return null;
  if (PLACEHOLDER.test(trimmed)) return null;
  // A trailing `:NNN` is a line reference ("packages/foo.ts:12"), not part of
  // the path. Strip it before resolving so line citations resolve by file.
  const candidate = trimmed.replace(/:\d+$/, "");
  if (absenceStatement(context, candidate)) return null;

  if (candidate.startsWith("@alfred/")) {
    const classified = specifierKind(candidate);
    if (classified.kind === "relative") return null;
    const { packageName, subpath } = classified;

    const entry = packages.get(packageName);
    if (entry === undefined) {
      return `names "${packageName}", which no workspace package declares — the package was deleted or renamed. Repoint it at the package that owns the door now.`;
    }
    if (subpath === ".") return null;
    if (entry.problem !== null) return null;

    const key = publishedKey(entry.keys, subpath);
    if (key === null) {
      return `names subpath "${subpath}" that ${packageName}'s exports map does not publish, so no importer can write it. Repoint it at the subpath that carries the door now.`;
    }

    const published = entry.keys.get(key);
    if (published.blocked) {
      return `names subpath "${subpath}" that ${packageName}'s exports map SEALS — the door is deliberately closed. Reword the reference.`;
    }

    if (key.includes("*")) {
      const resolvedPaths = published.targets.map((target) =>
        wildcardTargetPath(entry.dir, key, target, subpath),
      );
      if (!resolvedPaths.some((path) => path !== null && listed.has(path))) {
        return `resolves through ${packageName}'s wildcard exports key "${key}" to ${resolvedPaths
          .map((path) => `"${path}"`)
          .join(" / ")}, which no file git lists.`;
      }
    }
    return null;
  }

  const slash = candidate.indexOf("/");
  const firstSegment = slash === -1 ? candidate : candidate.slice(0, slash);
  const isPath = slash === -1 ? listed.has(candidate) : topLevelDirs.has(firstSegment);
  if (!isPath) return null;

  const normalized = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
  const exists =
    listed.has(normalized) || [...listed].some((file) => file.startsWith(`${normalized}/`));
  if (!exists) {
    return "names a path that no git-listed file or directory has — the file moved or was deleted. Repoint it at the current location.";
  }
  return null;
}

/**
 * Every locator failure across one set of docs and source comments.
 *
 * `docs` is `{ file, text }[]` of markdown prose, `sources` is `{ file, text }[]`
 * of source files whose comments are scanned. `allowed` maps `file:\`span\`` to
 * the reason the unresolved locator is honest; an entry with an empty reason, or
 * one that no span matches, is itself a failure.
 */
export function proseLocatorFailures({ docs, sources, packages, listed, allowed = new Map() }) {
  const failures = [];
  const usedAllowed = new Set();
  let checked = 0;

  for (const [key, reason] of allowed) {
    if (typeof reason !== "string" || reason.trim() === "") {
      failures.push(
        `ALLOWED entry "${key}" has no reason. If you cannot write one, the prose is wrong, not the check.`,
      );
    }
  }

  const topLevelDirs = new Set();
  for (const file of listed) {
    const slash = file.indexOf("/");
    if (slash !== -1) topLevelDirs.add(file.slice(0, slash));
  }

  const contexts = [];
  for (const doc of docs) {
    for (const { span, line, context } of markdownSpans(doc.text)) {
      contexts.push({ file: doc.file, line, span, context });
    }
  }
  for (const source of sources) {
    for (const block of commentBlocks(source.text)) {
      for (const { span, line, context } of commentSpans(block)) {
        contexts.push({ file: source.file, line, span, context });
      }
    }
  }

  for (const { file, line, span, context } of contexts) {
    const allowedKey = `${file}:\`${span}\``;
    if (allowed.has(allowedKey)) {
      usedAllowed.add(allowedKey);
      continue;
    }
    const problem = locatorProblem(span, context, { packages, listed, topLevelDirs });
    if (problem === null) {
      checked += 1;
      continue;
    }
    failures.push(`${file}:${line} \`${span}\` ${problem}`);
  }

  for (const [key] of allowed) {
    if (!usedAllowed.has(key)) {
      failures.push(
        `ALLOWED entry "${key}" matched no span — the prose it exempted is fixed or gone, so the entry is dead. Remove it.`,
      );
    }
  }

  failures.sort();
  return { failures, checked };
}
