// Where a TypeScript source takes its imports, read from the source text.
//
// Two checks need this and they need the same answer: `check-module-architecture.mjs`
// builds its package and module graph from it, and `web-boundaries.mjs` derives the
// browser scan surface from it. Both used to answer the question their own way, and
// the regex half was wrong in the way a regex over source text is always wrong — a
// specifier quoted in a comment or a template literal reads as an import, and one
// statement's clause runs into the next statement's.
//
// The walk below cannot make either mistake: comments, quoted strings and template
// literals are consumed by the lexer rather than matched around, and a statement
// ends at its `;`. What it still cannot see is a specifier that is not a literal —
// `import(name)` has nothing to read.
//
// Each consumer keeps its own fixtures. `check-module-architecture.mjs` drives this
// module from `selfTestFailures()` and `web-boundaries.mjs` from
// `web-boundaries.selftest.mjs`; both run inside `pnpm check`, so a broken change
// here fails two gates rather than none.

/**
 * Every import in a source text, in source order.
 *
 * `kind` is how the specifier was reached: a static `import`, an `export … from`,
 * a `dynamic-import`, or a `require`. `line` is 1-based and points at the
 * specifier. `clause` is the source between the `import`/`export` keyword and the
 * `from` token — what was bound, before resolution — and is empty for the forms
 * that bind nothing there: a side-effect import, a dynamic import, a `require`.
 *
 * Entries are deduplicated by line and specifier, so a file that reaches one
 * module twice on one line is one edge.
 *
 * @param {string} source
 * @returns {Array<{ kind: string, line: number, specifier: string, clause: string }>}
 */
export function parseImports(source) {
  const tokens = lexSource(source);
  const imports = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }

  function lineAt(position) {
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The bound names, taken from the source rather than rebuilt from the tokens. */
  function clauseBetween(keyword, fromToken) {
    if (!fromToken) return "";
    return source.slice(keyword.start + keyword.value.length, fromToken.start);
  }

  function add(token, kind, clause) {
    imports.push({
      kind,
      line: lineAt(token.start),
      specifier: token.value,
      clause,
    });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier") continue;
    const next = tokens[index + 1];
    const argument = tokens[index + 2];
    if (
      (token.value === "import" || token.value === "require") &&
      next?.value === "(" &&
      argument?.kind === "string"
    ) {
      add(argument, token.value === "import" ? "dynamic-import" : "require", "");
      continue;
    }
    if (token.value === "import") {
      /** @type {(typeof tokens)[number] | null} */
      let fromToken = null;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.value === ";") break;
        // The last `from` before the specifier, so `import { from } from "x"`
        // measures its clause from the keyword, not from the bound name. The
        // kind test matters: a specifier may itself be the string `"from"`.
        if (candidate.kind === "identifier" && candidate.value === "from") fromToken = candidate;
        else if (candidate.kind === "string") {
          add(candidate, "import", clauseBetween(token, fromToken));
          break;
        }
      }
      continue;
    }
    if (token.value === "export") {
      /** @type {(typeof tokens)[number] | null} */
      let fromToken = null;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.value === ";") break;
        if (candidate.kind === "identifier" && candidate.value === "from") fromToken = candidate;
        else if (fromToken && candidate.kind === "string") {
          add(candidate, "export", clauseBetween(token, fromToken));
          break;
        }
      }
    }
  }
  return [
    ...new Map(imports.map((entry) => [`${entry.line}:${entry.specifier}`, entry])).values(),
  ].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

/**
 * The source as identifiers, string literals and single punctuation characters.
 *
 * Whitespace, line comments, block comments and template literals are consumed
 * and produce no token, which is what makes every consumer blind to a specifier
 * that is only mentioned. String literals keep their unescaped value, so a token
 * of kind `string` is the module name a resolver would receive.
 *
 * @param {string} source
 * @returns {Array<{ kind: "identifier" | "string" | "punctuation", start: number, value: string }>}
 */
export function lexSource(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: "string", start, value });
      continue;
    }
    if (char === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "`") {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: "identifier", start, value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", start: index, value: char });
    index += 1;
  }
  return tokens;
}
