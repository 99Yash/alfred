// Tautological-test guard — the "assert behaviour, not spelling" table.
//
// One table, two consumers (like consolidation-rules.mjs):
//   - `check-test-tautology.mjs` runs `gate` rules in `pnpm check`.
//   - `.claude/hooks/helper-hints.mjs` (future) can run every rule at edit time.
// Two severities: `gate` fails the build, `hint` is advisory.
//
// Escape hatch: append `// tautology-ok: <reason>` to the violating line, or
// to any line in the chain span, or to the comment block directly above it.
// An empty marker is itself a violation: exemptions must explain the property
// that makes the tautology load-bearing (incident, policy, cross-source
// agreement).
//
// The rules are intentionally narrow and greppable — they catch the
// mechanically detectable shapes (T1 rebuilt oracle, T4 position==index).
// The broader judgment (literal pin without `why`, existence-only, mock-count
// without wire assert) stays in `docs/reference/code-style.md` §5 and review.

/**
 * @typedef {object} TautologyRule
 * @property {string}   id
 * @property {RegExp}   re
 * @property {"gate"|"hint"} severity
 * @property {"line"|"chain"} [scope]
 * @property {string}   fix
 * @property {string[]} [owners]
 * @property {RegExp}   [paths]
 */

/** @type {TautologyRule[]} */
export const RULES = [
  {
    id: "rebuilt-position-index",
    // `assert.deepEqual(xs.map(c => c.position), xs.map((_, i) => i))` —
    // expected is rebuilt from actual's length, so the test cannot fail when
    // `position` is wrong, only when length is. The literal form `[0,1]` is
    // the fix, or a loop `assert.equal(c.position, i)`.
    re: /\.map\(\s*\([^)]*\)\s*=>\s*[^)]*\.position\s*\)[^;]*?\.map\(\s*\([^,]*,\s*i\s*\)\s*=>\s*i\s*\)/,
    scope: "chain",
    severity: "gate",
    fix: "Do not rebuild expected `0..N-1` from actual.length. Assert a literal `deepEqual(..., [0,1])` or loop `assert.equal(c.position, i)`. A rebuilt oracle cannot fail when `position` is wrong.",
  },
  {
    id: "self-mirroring-oracle",
    // Both sides of an `assert.equal/deepEqual` are the same callee, so the
    // test mirrors the SUT instead of pinning a literal/external golden.
    // e.g. `assert.equal(hashToolInput(a, b), hashToolInput(a, c))`
    // `assert.equal(stream(chunks), sanitizeVoice(full))` is the same shape
    // but is a legitimate cross-check of two code paths — it carries a
    // `// tautology-ok: cross-check` marker plus one literal-anchored test.
    //
    // Heuristic: two calls to the same identifier inside one assert.equal
    // argument list. Narrow to reduce false positives: the identifier must
    // appear twice and be a plausible SUT name (not `assert`/`expect`).
    re: /assert\.(?:equal|deepEqual|deepStrictEqual)\(\s*([a-zA-Z_]\w*)\s*\([^)]*\)[^;]*?\b\1\s*\(/,
    scope: "chain",
    severity: "hint",
    fix: "Both sides call the same function — the test mirrors the SUT. Pin one side to a literal or external artifact. If intentionally cross-checking two paths (e.g. `stream()` vs `sanitizeVoice()`), anchor the shared oracle with one literal test and add `// tautology-ok: cross-check + anchored at <file:line>`.",
  },
  {
    id: "literal-cap-pin-without-why",
    // `assert.equal(EMBED_COST_CAP_USD, 0.5)` with no `// why:` / `#NNN` /
    // `ADR-` in the preceding 3 lines or trailing comment. A bare literal pin
    // is a change detector with no policy — it fails only when you edit both
    // files together.
    re: /assert\.equal\(\s*EMBED_COST_CAP_USD\s*,\s*0\.5\s*\)/,
    scope: "chain",
    severity: "hint",
    fix: "A bare literal pin `EMBED_COST_CAP_USD == 0.5` is a change detector with no policy. Add `// why: <incident/ADR>` or delete — the math tests (`maxTokensForPrice`) already exercise the cap. If the literal must stay (policy gate), add `// tautology-ok: policy — $0.50 cap is the product limit`.",
  },
];

/**
 * Path predicate — only test files carry tautological-test risk. Eval/script
 * fixtures are excluded. Mirrors `isScannedPath` shape so consumers can call it
 * uniformly.
 * @param {string} file Repo-relative path.
 */
export const isTestPath = (file) => /\.test\.tsx?$/.test(file);

/**
 * True if a file needs to be scanned for tautology rules. Narrower than
 * `listGitSourceFiles` output: a consumer can pre-filter on this before reading.
 * @param {string} file
 */
export const isScannedPath = (file) => isTestPath(file) || RULES.some((r) => r.paths?.test(file));

const coversFile = (rule, file) =>
  (rule.paths ? rule.paths.test(file) : isTestPath(file)) && !rule.owners?.includes(file);

/**
 * Match one line against line-scoped rules.
 * @param {string} line
 * @param {string} file
 * @param {"gate"|"all"} lanes
 * @returns {TautologyRule[]}
 */
export function matchLine(line, file, lanes) {
  if (line.includes("// tautology-ok")) return [];
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return [];
  return RULES.filter(
    (rule) =>
      rule.scope !== "chain" &&
      (lanes === "all" || rule.severity === "gate") &&
      coversFile(rule, file) &&
      rule.re.test(line),
  );
}

const isCommentLine = (line) => /^\s*(?:\/\/|\*|\/\*)/.test(line);

const codeOnly = (text) =>
  text
    .split("\n")
    .map((line) => (isCommentLine(line) ? " ".repeat(line.length) : line))
    .join("\n");

/**
 * Match chain rules against whole file text.
 * `// tautology-ok:` suppresses when on any line the match touches OR the
 * comment block directly above (same as consolidation `matchChains`).
 * @param {string} text
 * @param {string} file
 * @param {"gate"|"all"} lanes
 * @returns {{rule: TautologyRule, line: number, text: string}[]}
 */
export function matchChains(text, file, lanes) {
  const code = codeOnly(text);
  const lines = text.split("\n");
  /** @type {{rule: TautologyRule, line: number, text: string}[]} */
  const found = [];
  for (const rule of RULES) {
    if (rule.scope !== "chain") continue;
    if (lanes !== "all" && rule.severity !== "gate") continue;
    if (!coversFile(rule, file)) continue;
    const re = new RegExp(rule.re.source, `${rule.re.flags.replace(/g/g, "")}g`);
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const start = code.lastIndexOf("\n", m.index) + 1;
      const lineEnd = code.indexOf("\n", m.index + m[0].length);
      const first = code.slice(0, start).split("\n").length - 1;
      const last =
        lineEnd === -1 ? lines.length - 1 : code.slice(0, lineEnd).split("\n").length - 1;
      let markerFrom = first;
      while (markerFrom > 0 && isCommentLine(lines[markerFrom - 1])) markerFrom--;
      const exempt = lines
        .slice(markerFrom, last + 1)
        .some((l) => /\/\/\s*tautology-ok:\s*\S/.test(l));
      if (exempt) continue;
      found.push({
        rule,
        line: first + 1,
        text: lines
          .slice(first, last + 1)
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" "),
      });
    }
  }
  return found;
}
