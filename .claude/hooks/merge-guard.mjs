#!/usr/bin/env node
// PreToolUse guard for Bash: denies a merge that skips the required checks.
//
// `gh pr merge --admin` merges past red required checks. Agents used it twice
// (#1491 and #1505 merged with `static` red) and each time a fix PR followed
// (#1497, #1506). An agent waits for CI with `node scripts/wait-pr-checks.mjs <n>`
// and fixes the red check. The owner merges past red by hand.
//
// What it denies, in any simple command of the Bash input:
//   - `gh pr merge … --admin` (also `--admin=<value>`, except `--admin=false`).
//   - `gh api … repos/<o>/<r>/pulls/<n>/merge` with method PUT. `gh` does no
//     check-state test before this call, so an admin token can merge past red.
//   - `gh api graphql … mergePullRequest …`, the GraphQL form of the same merge.
// A plain `gh pr merge` is allowed: `gh` refuses it while the base branch policy
// blocks the merge, and its error names `--admin` as the way past.
//
// What it does not deny: text that only quotes these commands. A quoted string is
// one word, so `git commit -m "never gh pr merge --admin"` passes, and so does a
// heredoc body. A quoted string passed to `bash -c`, `sh -c`, `zsh -c` or `eval`
// is a script, so it is scanned. `$(…)` and backticks are scanned too, also inside
// double quotes. It does not see aliases, scripts on disk, or `curl` to the API.
//
// Hook contract (code.claude.com/docs/en/hooks): PreToolUse JSON on stdin with
// `tool_name` and `tool_input.command`. A deny prints
// `hookSpecificOutput.permissionDecision: "deny"` and exits 0. Input that does not
// parse is allowed: this guard must not break every Bash call.
//
// `scripts/merge-guard.selftest.mjs` (`pnpm check:merge-guard`) holds the fixtures.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const REASON = [
  "Blocked: this merge skips the required checks.",
  "Do not merge past a red check.",
  "Wait for CI with `node scripts/wait-pr-checks.mjs <n>`.",
  "Fix each red check with a new commit, then wait again.",
  "Only the owner merges past red, by hand.",
].join(" ");

// ---------------------------------------------------------------------------
// Shell words. Not a full shell parser: it splits simple commands at control
// operators, keeps quoted text as one word, skips comments and heredoc bodies,
// and collects the scripts inside `$(…)` and backticks for a separate scan.
// ---------------------------------------------------------------------------

/**
 * Reads a `$(…)` body that starts at `start` (after the `$(`).
 * @param {string} src
 * @param {number} start
 * @returns {[string, number]} the body, and the index after the closing `)`
 */
function readSubstitution(src, start) {
  let depth = 1;
  let i = start;
  /** @type {"'" | '"' | null} */
  let quote = null;

  while (i < src.length) {
    const c = src[i];

    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (quote === '"') {
      if (c === "\\") i += 1;
      else if (c === '"') quote = null;
    } else if (c === "\\") {
      i += 1;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;

      if (depth === 0) return [src.slice(start, i), i + 1];
    }

    i += 1;
  }

  return [src.slice(start), src.length];
}

/**
 * Reads a backtick body that starts at `start` (after the opening backtick).
 * @param {string} src
 * @param {number} start
 * @returns {[string, number]} the body, and the index after the closing backtick
 */
function readBacktick(src, start) {
  let i = start;
  let body = "";

  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\" && i + 1 < src.length) {
      body += src[i + 1];
      i += 2;
      continue;
    }

    body += src[i];
    i += 1;
  }

  return [body, i + 1];
}

/**
 * Splits `src` into simple commands (arrays of unquoted words). Pushes the body of
 * every command substitution onto `nested`.
 */
function splitCommands(src, nested) {
  const commands = [];
  let words = [];
  let word = "";
  let inWord = false;
  const heredocs = [];
  let i = 0;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };

  const endCommand = () => {
    endWord();

    if (words.length > 0) commands.push(words);
    words = [];
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "\n") {
      endCommand();
      i += 1;

      // Skip each pending heredoc body: the lines up to its delimiter are data.
      while (heredocs.length > 0) {
        const { delim, strip } = heredocs.shift();

        while (i < src.length) {
          const nl = src.indexOf("\n", i);
          const end = nl === -1 ? src.length : nl;
          const line = src.slice(i, end);
          i = end + 1;

          if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
        }
      }

      continue;
    }

    if (c === " " || c === "\t") {
      endWord();
      i += 1;
      continue;
    }

    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
      i += 1;
      continue;
    }

    if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }

    if (c === "<" && src.startsWith("<<", i) && !src.startsWith("<<<", i)) {
      endWord();
      i += 2;
      const strip = src[i] === "-";

      if (strip) i += 1;

      while (src[i] === " " || src[i] === "\t") i += 1;
      const m = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i));

      if (m) {
        heredocs.push({ delim: m[2], strip });
        i += m[0].length;
      }

      continue;
    }

    if (c === "\\") {
      if (i + 1 < src.length && src[i + 1] !== "\n") word += src[i + 1];
      inWord = true;
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      word += src.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }

    if (c === "$" && src[i + 1] === "'") {
      let j = i + 2;

      while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      word += src.slice(i + 2, j);
      inWord = true;
      i = j + 1;
      continue;
    }

    if (c === '"') {
      inWord = true;
      i += 1;

      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          word += src[i + 1];
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(") {
          const [body, next] = readSubstitution(src, i + 2);
          nested.push(body);
          i = next;
        } else if (src[i] === "`") {
          const [body, next] = readBacktick(src, i + 1);
          nested.push(body);
          i = next;
        } else {
          word += src[i];
          i += 1;
        }
      }

      i += 1;
      continue;
    }

    if (c === "$" && src[i + 1] === "(") {
      const [body, next] = readSubstitution(src, i + 2);
      nested.push(body);
      inWord = true;
      i = next;
      continue;
    }

    if (c === "`") {
      const [body, next] = readBacktick(src, i + 1);
      nested.push(body);
      inWord = true;
      i = next;
      continue;
    }

    word += c;
    inWord = true;
    i += 1;
  }

  endCommand();

  return commands;
}

// ---------------------------------------------------------------------------
// Command rules.
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);

const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "sudo", "env"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const MERGE_ENDPOINT = /^\/?repos\/[^/\s]+\/[^/\s]+\/pulls\/[^/\s]+\/merge\/?$/;

/** Drops keywords, `VAR=value` words, and wrappers such as `env` or `sudo`. */
function argvOf(words) {
  let i = 0;

  while (i < words.length) {
    const w = words[i];

    if (KEYWORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
    } else if (WRAPPERS.has(w)) {
      i += 1;

      // Wrapper flags (`env -i`, `sudo -u root`); `sudo -u` takes a value.
      while (i < words.length && words[i].startsWith("-")) {
        i += words[i] === "-u" ? 2 : 1;
      }
    } else {
      break;
    }
  }

  return words.slice(i);
}

/** The script text a shell or `eval` runs, or null. */
function innerScript(argv) {
  const name = basename(argv[0] ?? "");

  if (name === "eval") return argv.slice(1).join(" ");

  if (!SHELLS.has(name)) return null;

  for (let i = 1; i < argv.length; i += 1) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(argv[i])) return argv[i + 1] ?? null;
  }

  return null;
}

function isAdminFlag(word) {
  if (word === "--admin") return true;

  if (word.startsWith("--admin=")) return word.slice("--admin=".length).toLowerCase() !== "false";

  return false;
}

function apiMethod(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const w = argv[i];

    if (w === "-X" || w === "--method") return String(argv[i + 1] ?? "").toUpperCase();

    if (w.startsWith("--method=")) return w.slice("--method=".length).toUpperCase();

    if (/^-X./.test(w)) return w.slice(2).toUpperCase();
  }

  return "GET";
}

/** Returns a reason string when this argv is a bypass merge, else null. */
function ruleFor(argv) {
  if (basename(argv[0] ?? "") !== "gh") return null;

  const positional = argv.slice(1).filter((w) => !w.startsWith("-"));

  if (positional[0] === "pr" && positional[1] === "merge") {
    return argv.some(isAdminFlag) ? "`gh pr merge --admin`" : null;
  }

  if (positional[0] === "api") {
    if (argv.some((w) => MERGE_ENDPOINT.test(w)) && apiMethod(argv) === "PUT") {
      return "`gh api` PUT on `pulls/<n>/merge`";
    }

    if (argv.includes("graphql") && argv.some((w) => /\bmergePullRequest\b/.test(w))) {
      return "`gh api graphql` with `mergePullRequest`";
    }
  }

  return null;
}

/** Scans a Bash input. Returns the matched form, or null. */
export function findBypass(src, depth = 0) {
  if (depth > 4 || !/\bgh\b/.test(src)) return null;

  const nested = [];

  for (const words of splitCommands(src, nested)) {
    const argv = argvOf(words);

    if (argv.length === 0) continue;

    const hit = ruleFor(argv);

    if (hit) return hit;

    const inner = innerScript(argv);

    if (inner) {
      const innerHit = findBypass(inner, depth + 1);

      if (innerHit) return innerHit;
    }
  }

  for (const body of nested) {
    const hit = findBypass(body, depth + 1);

    if (hit) return hit;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry. It runs only as the hook process, not when the selftest imports this file.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let payload;

  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }

  // Same read as helper-hints.mjs: a missing field is no command, not a failure.
  const command = payload?.tool_name === "Bash" ? payload.tool_input?.command : undefined;

  if (command === undefined || command === null) process.exit(0);

  const hit = findBypass(String(command));

  if (!hit) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${REASON} (Matched: ${hit}.)`,
      },
    }),
  );
}
