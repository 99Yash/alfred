// The single table of "we already have a helper for this" facts.
//
// One table, two consumers, so the fact cannot drift between them:
//   - `check-consolidation-drift.mjs` runs the `gate` rules in `pnpm check`.
//     A match fails the build the same way a type error does.
//   - `.claude/hooks/helper-hints.mjs` runs *every* rule against the text an
//     agent is about to write, and injects `fix` before the edit lands.
//
// Two severities, because the two consumers can afford different strictness:
//   - "gate": fully consolidated to one owner, so a match is unambiguously
//     drift rather than un-migrated legacy. Fails `pnpm check`.
//   - "hint": the canonical helper exists and is preferred, but enough legacy
//     call sites remain (or the pattern is broad enough) that banning it would
//     gate on a migration. Advisory at edit time only; never fails a build.
//
// A row here replaces a row in the root CLAUDE.md "reach for…" table. That is
// the point: a fact enforced by a check does not also need to be prose that
// every session pays for and nothing keeps current. When a "hint" row's legacy
// call sites reach zero, promote it to "gate" and delete its prose row too.
//
// Escape hatch: append `// drift-ok: <reason>` to a line. An empty marker is
// itself drift: exemptions must explain the lock/property that makes them safe.

/**
 * @typedef {object} ConsolidationRule
 * @property {string}   id        Stable slug, used in hook output.
 * @property {RegExp}   re        Matched per line, or against whole file text
 *                                when `scope` is "chain".
 * @property {"gate"|"hint"} severity
 * @property {"line"|"chain"} [scope] Default "line". "chain" for an idiom that
 *                                a formatter splits across lines — see
 *                                {@link matchChains}.
 * @property {string}   fix       What to reach for instead.
 * @property {string[]} [owners]  Repo-relative files that legitimately contain
 *                                the idiom (the helper's own definition, its
 *                                doc-comment example, or the sanctioned reader).
 *                                Scoped per rule: owning `toStringArray` does
 *                                not license every other idiom in that file.
 *                                Prefer a per-line `// drift-ok: <reason>` when
 *                                the file holds both sanctioned and new call
 *                                sites — a whole-file exemption blinds the rule
 *                                exactly where the next mistake will be made.
 */

/** @type {ConsolidationRule[]} */
export const RULES = [
  {
    id: "as-string-array",
    // `x as string[]` — the unchecked element-type assertion. `as string[] | ...`
    // (a union) is a different, narrower shape and is left alone.
    re: /\bas\s+string\[\](?!\s*[|&])/,
    severity: "gate",
    owners: ["packages/contracts/src/guards.ts"],
    fix: "Use toStringArray(x) from @alfred/contracts — it checks the element type at runtime instead of asserting it.",
  },
  {
    id: "canonical-param-key",
    // The `.toLowerCase().replace(/[_-]/g, "")` key-canonicalization idiom.
    re: /\.toLowerCase\(\)\.replace\(\s*\/\[_-\]\/g\s*,\s*""\s*\)/,
    severity: "gate",
    owners: ["packages/contracts/src/tool-schemas.ts"],
    fix: "Use canonicalParamKey(key) from @alfred/contracts — the one canonical key-folding function.",
  },
  {
    id: "hand-rolled-timezone-validator",
    // A hand-rolled `function isValidTimezone` — this exact `Intl.DateTimeFormat`
    // trial was copied verbatim into web, sync, and api before consolidation.
    re: /\bfunction\s+isValidTimezone\b/,
    severity: "gate",
    fix: "Use isIanaTimezone from @alfred/contracts — the one memoized, alias-aware timezone validator. Don't hand-roll an Intl.DateTimeFormat trial.",
  },
  {
    id: "as-tool-name",
    // Zero production call sites: every `as ToolName` left in the tree is in a
    // test fixture, which this check already skips.
    re: /\bas\s+ToolName\b/,
    severity: "gate",
    fix: "Narrow the string with isToolName from @alfred/contracts before indexing a ToolName record or dispatching. Don't assert it.",
  },
  {
    id: "raw-process-env",
    // The repo invariant, promoted out of prose. Only the env package's own
    // schema readers and Drizzle's standalone config may touch process.env;
    // tests//scripts/ are skipped by the path filter, not listed here.
    re: /\bprocess\.env\b/,
    severity: "gate",
    owners: [
      "packages/env/src/server.ts",
      "packages/env/src/database.ts",
      "packages/db/drizzle.config.ts",
    ],
    fix: "Use serverEnv() from @alfred/env/server — the only sanctioned reader of process env. It validates the whole environment once against a schema.",
  },
  {
    id: "error-to-message",
    // `err instanceof Error ? err.message : String(err)`, exactly. Deliberately
    // does NOT match the stack-preferring variant
    // (`err instanceof Error ? (err.stack ?? err.message) : String(err)`) or a
    // domain-specific fallback (`: "Invalid JSON"`), which are different calls.
    re: /instanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(/,
    severity: "gate",
    owners: ["packages/contracts/src/errors.ts"],
    fix: "Use toMessage(err) from @alfred/contracts — the one caught-error-to-string helper.",
  },
  {
    id: "hand-built-api-error",
    // Ten `class XError extends ApiError` subclasses re-encoded API_ERROR_CODES
    // and each had to be imported by name; the codes are now the only encoding
    // and `Errors` is the only door. Both drift shapes: a fresh subclass, and a
    // direct `new ApiError(...)` that pairs a message with a code by hand.
    re: /\bnew\s+ApiError\s*\(|\bextends\s+ApiError\b/,
    severity: "gate",
    owners: ["packages/contracts/src/api-errors.ts"],
    fix: "Throw an Errors.* factory from @alfred/contracts — `throw Errors.NotFoundError(\"…\")`. It owns the code-to-status pairing. Catch with isApiError(err, \"NOT_FOUND\") rather than a per-kind class.",
  },

  // ---- hints: canonical helper exists, legacy call sites remain -------------
  {
    id: "hand-rolled-record-guard",
    re: /typeof\s+(\w+)\s*===\s*["']object["']\s*&&\s*\1\s*!==\s*null/,
    severity: "hint",
    fix: "isRecord(x) from @alfred/contracts is this check. Use toRecord(x) if you want a Record or {} back rather than a boolean.",
  },
  {
    id: "raw-json-parse",
    re: /\bJSON\.parse\(/,
    severity: "hint",
    fix: "parseJsonWith(raw, schema, fallback?) from @alfred/contracts parses AND validates in one step; safeJsonParse(raw) handles malformed input without a try/catch. Reach for those before JSON.parse + a cast.",
  },
  {
    id: "raw-intl-timezone",
    re: /new\s+Intl\.DateTimeFormat\(/,
    severity: "hint",
    owners: ["packages/api/src/modules/timezone/local-time.ts"],
    fix: "@alfred/api's timezone module owns every date/zone reading, split by one question: does the reading need a zone? NEEDS ONE — inZone(tz) binds it once and every reading is a method: .day() mints the LocalDateKey, .hour(), .offsetMs(), .clock(), .startOf(key, hour?), .dayBounds(), .format(instant). DOESN'T — a free function on the key: addDays (day math on the key, never in ms), weekdayIndex (day-of-week DECISIONS — never string-match a rendered weekday name), formatDay(key, \"short\"|\"long\"|\"weekday\"). Zones are IanaTimezone (settings.resolveTimezone, parseIanaTimezone); day keys are LocalDateKey (parseLocalDateKey / isLocalDateKey at a persistence or wire boundary) — both branded, so a plain string won't type-check. A bare Intl trial once broke briefings on \"UTC\", and a per-call-site UTC reading dated triage todos a day early.",
  },
  {
    id: "hand-rolled-utc-offset-parse",
    // The `longOffset` → "GMT-05:00" parse. One reader owns it; a second copy
    // is how the same zone got three different offset answers.
    re: /timeZoneName:\s*["']longOffset["']|GMT\(\?:/,
    severity: "gate",
    owners: ["packages/api/src/modules/timezone/local-time.ts"],
    fix: "Use inZone(timezone).offsetMs(instant) from @alfred/api's timezone module — the one place the longOffset string is parsed. inZone(tz).clock(instant).utcOffset gives the signed ISO fragment.",
  },
  {
    id: "stale-google-access-token",
    re: /\brefreshAccessToken\b|\bcredential(?:s)?\.accessToken\b/,
    severity: "hint",
    fix: "Resolve Google tokens with getFreshAccessToken from @alfred/integrations/google. The persisted accessToken and a manual refresh are both the stale path — and the token is a secret, so never log or persist it on an error.",
  },
  {
    id: "raw-provider-client",
    re: /new\s+Anthropic\(|createAnthropic\(|createGoogleGenerativeAI\(/,
    severity: "hint",
    fix: "Use getChatModel / getCheapModel / getBossModel from @alfred/ai instead of constructing a provider client — they carry the retry wrapper, metering, and per-model capability map.",
  },
  {
    id: "raw-email-normalize",
    re: /\.match\(\s*\/<\s*\(\?/,
    severity: "hint",
    fix: "Use parseEmailAddress(value) from @alfred/contracts to pull an address out of a `Name <addr>` header and normalize it. It is also the single source of self-mail matching.",
  },
  {
    id: "spread-over-defaults",
    // `{ ...DEFAULT_X, ...overrides }` — a defaults object (SCREAMING_CASE or
    // `defaultFoo`) with a second spread layered on top. A *present* `undefined`
    // wins a spread, so one explicitly-undefined override key zeroes the default
    // it was meant to fall back to. `exactOptionalPropertyTypes` only catches
    // that while the override type stays narrow (`{ k?: T }`), which makes
    // narrowness load-bearing at a site that never says so — and every
    // `AttributedCall` field is already widened, so the flag catches nothing
    // there. Anchored on the defaults-naming convention: `{ ...input,
    // ...sanitized }` and friends are overlays, not defaults resolution.
    re: /\{\s*\.\.\.(?:[A-Z][A-Z0-9_]{2,}|default[A-Z]\w*|defaults)\s*,\s*\.\.\./,
    severity: "gate",
    fix: "Use withDefaults(DEFAULTS, overrides) from @alfred/contracts — it ignores override keys whose value is undefined, so a default can't be zeroed by a present-undefined.",
  },
  {
    id: "unguarded-agent-run-status-write",
    // A status write to `agent_runs` outside the executor's guarded door: a bare
    // `.where(eq(agentRuns.id, ...))` compiles, reads fine, and silently
    // resurrects a run a concurrent cancel just took terminal (#530, and review
    // finding D1 — which was exactly this shape, thirty lines below the door).
    //
    // "chain", because this is the idiom a per-line regex cannot see. Prettier
    // puts `.update(agentRuns)`, `.set({`, `status:` and `.where(…)` on four
    // separate lines, so the earlier one-line version of this rule matched
    // exactly zero of the repo's six write sites — it could only ever have
    // fired on a hand-collapsed one-liner. The span is bounded by `;` so it
    // cannot run past the end of the statement into an unrelated
    // `update(agentSteps).set({ status: … })`, and `status:` is matched anywhere
    // inside the payload so a nested `error: { … }` before it does not hide it.
    //
    // Known limit: only a `.set({ … })` object *literal* is visible. The door's
    // own `.set(set)` (a `PgUpdateSetSource` parameter) is opaque to any regex —
    // that one is covered by the door being the thing every caller goes
    // through, not by this rule.
    //
    // No `owners`: every legitimate writer carries an inline `// drift-ok:` with
    // its reason instead. A whole-file exemption for executor.ts and service.ts
    // is what made the previous version unable to catch D1, which lived in
    // executor.ts. This is a build-time detector for the common direct-write
    // shapes, not a type-level proof that every possible SQL construction goes
    // through the guarded door.
    re: /\bupdate\(\s*agentRuns\s*\)[^;]*?\.set\(\s*\{[^;]*?(?:\bstatus\s*(?::|(?=[,}]))|\[\s*["']status["']\s*\]\s*:)/,
    scope: "chain",
    severity: "gate",
    fix: "Route `agent_runs.status` writes through commitGuardedRunUpdate in packages/api/src/modules/agent/executor.ts — it takes the row lock, refuses a superseded attempt, and refuses to write a live status over a terminal one. A bare .where(eq(agentRuns.id, …)) resurrects cancelled runs (#530). If the transaction already holds FOR UPDATE on the row and has checked the status under that lock (leaseRun's backstop), append `// drift-ok: <that reason>` to the `.update(agentRuns)` line.",
  },
  {
    id: "unguarded-agent-run-status-upsert",
    re: /\binsert\(\s*agentRuns\s*\)[^;]*?\.onConflictDoUpdate\(\s*\{[^;]*?\bset\s*:\s*\{[^;]*?(?:\bstatus\s*(?::|(?=[,}]))|\[\s*["']status["']\s*\]\s*:)/,
    scope: "chain",
    severity: "gate",
    fix: "Do not upsert agent_runs.status. Route lifecycle transitions through the owning agent service/executor door so terminal-state and attempt guards cannot be bypassed.",
  },
  {
    id: "raw-agent-run-status-sql",
    re: /\bUPDATE\s+(?:"?agent_runs"?)\s+SET\b[^;]*?\bstatus\s*=/i,
    scope: "chain",
    severity: "gate",
    fix: "Do not write agent_runs.status with raw SQL. Route lifecycle transitions through the owning agent service/executor door.",
  },
];

/**
 * Path predicate → skip. Tests/evals/scripts/backfills legitimately use casts
 * and raw env reads for fixture ergonomics; generated + built output isn't
 * source. Shared so the gate and the edit-time hook agree on scope.
 * @param {string} file Repo-relative path.
 */
export const isSkippedPath = (file) =>
  /(^|\/)(dist|build|coverage|node_modules)\//.test(file) ||
  /\.(d|gen)\.ts$/.test(file) ||
  /\.test\.tsx?$/.test(file) ||
  /(^|\/)(test|__mocks__|evals)\//.test(file) ||
  file.endsWith(".eval.ts") ||
  /(^|\/)scripts\//.test(file);

/**
 * Match one line against the rules in scope for a file.
 * @param {string} line
 * @param {string} file Repo-relative path, for per-rule owner exemptions.
 * @param {"gate"|"all"} lanes Which severities to report.
 * @returns {ConsolidationRule[]}
 */
export function matchLine(line, file, lanes) {
  if (line.includes("// drift-ok")) return [];
  // Skip whole-line comments — doc examples of a banned idiom are not drift.
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return [];
  return RULES.filter(
    (rule) =>
      rule.scope !== "chain" &&
      (lanes === "all" || rule.severity === "gate") &&
      !rule.owners?.includes(file) &&
      rule.re.test(line),
  );
}

/** True for a line that is only a comment, so a doc example is not drift. */
const isCommentLine = (line) => /^\s*(?:\/\/|\*|\/\*)/.test(line);

/**
 * Blank every comment-only line while preserving byte offsets of the rest, so a
 * chain match can span a commented gap (a `.set({ … })` payload with a comment
 * inside it is one statement) without a doc example counting as drift.
 * @param {string} text
 */
const codeOnly = (text) =>
  text
    .split("\n")
    .map((line) => (isCommentLine(line) ? " ".repeat(line.length) : line))
    .join("\n");

/**
 * Match the `scope: "chain"` rules against a whole file (or a whole edit body).
 *
 * `matchLine` is per-line, which is structurally blind to a formatted query
 * builder: `.update(agentRuns)`, `.set({`, and `.where(…)` land on separate
 * lines, so a single-line regex over the chain matches nothing. A chain rule's
 * `re` is run over the joined text instead, and is expected to bound its own
 * span (e.g. `[^;]*?`) so a match cannot silently swallow the next statement.
 *
 * `// drift-ok` suppresses a match when it appears on any line the match touches
 * OR in the run of comment lines directly above it — the reason for a
 * multi-line chain rarely fits as a trailing comment, so it lives in the
 * statement's own comment block.
 *
 * @param {string} text Full file contents, or the text an edit would add.
 * @param {string} file Repo-relative path, for per-rule owner exemptions.
 * @param {"gate"|"all"} lanes Which severities to report.
 * @returns {{rule: ConsolidationRule, line: number, text: string}[]} `line` is
 *   1-based and points at the first line of the match.
 */
export function matchChains(text, file, lanes) {
  const code = codeOnly(text);
  const lines = text.split("\n");
  /** @type {{rule: ConsolidationRule, line: number, text: string}[]} */
  const found = [];
  for (const rule of RULES) {
    if (rule.scope !== "chain") continue;
    if (lanes !== "all" && rule.severity !== "gate") continue;
    if (rule.owners?.includes(file)) continue;
    const re = new RegExp(rule.re.source, `${rule.re.flags.replace(/g/g, "")}g`);
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      // Widen the match to the whole lines it touches: that is the unit the
      // reported snippet works in.
      const start = code.lastIndexOf("\n", m.index) + 1;
      const lineEnd = code.indexOf("\n", m.index + m[0].length);
      const first = code.slice(0, start).split("\n").length - 1;
      const last =
        lineEnd === -1 ? lines.length - 1 : code.slice(0, lineEnd).split("\n").length - 1;
      // Then widen again, for the marker only, over the comment block above.
      let markerFrom = first;
      while (markerFrom > 0 && isCommentLine(lines[markerFrom - 1])) markerFrom--;
      const exempt = lines
        .slice(markerFrom, last + 1)
        .some((line) => /\/\/\s*drift-ok:\s*\S/.test(line));
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
