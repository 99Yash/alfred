#!/usr/bin/env node
// Recall hook for the repo lessons system (.lessons/).
// Modes:
//   session-start  -> inject a short pointer to .lessons/ (not the index: it is too big)
//   prompt         -> inject one pointer line per lesson whose keywords match the prompt
//   pre-edit       -> inject one pointer line per lesson whose globs match the edited
//                     file, only for a file inside this repo or one of its worktrees
// Each hook injects pointers, not lesson bodies: the agent opens the file it needs.
// Reads hook JSON from stdin (prompt/pre-edit), prints hookSpecificOutput JSON to
// stdout, and exits 0. Prints nothing when there is no match (no injection).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const mode = process.argv[2] || "session-start";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const LESSONS_DIR = join(ROOT, ".lessons");

const EVENT =
  {
    "session-start": "SessionStart",
    prompt: "UserPromptSubmit",
    "pre-edit": "PreToolUse",
  }[mode] || "SessionStart";

function emit(text) {
  if (!text || !text.trim()) process.exit(0);
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: text } }),
  );
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function toArr(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function basename(p) {
  return p.split("/").pop();
}

function splitWords(s) {
  return s
    ? String(s)
        .toLowerCase()
        .replace(/[^a-z0-9.\-_]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    : [];
}

function globMatch(glob, path) {
  if (!glob) return false;
  glob = String(glob);
  let re = "";

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;

        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }

  try {
    return new RegExp("^" + re + "$").test(path);
  } catch {
    return false;
  }
}

function listLessonFiles() {
  if (!existsSync(LESSONS_DIR)) return [];

  return readdirSync(LESSONS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== "README.md")
    .map((f) => join(LESSONS_DIR, f));
}

function parseLesson(path) {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fmText = m ? m[1] : "";
  const body = (m ? m[2] : raw).trim();
  const fm = {};

  for (const line of fmText.split("\n")) {
    const mm = line.match(/^(\w+):\s*(.*)$/);

    if (!mm) continue;
    let v = mm[2].trim();

    if (v.startsWith("[") && v.endsWith("]")) {
      v = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, "");
    }

    fm[mm[1]] = v;
  }

  return { path, fm, body };
}

function pointerLine({ path, fm }) {
  const symptom = typeof fm.symptom === "string" ? fm.symptom : "";
  const hook = symptom.length > 200 ? `${symptom.slice(0, 200)}…` : symptom;
  return `- ${fm.title || basename(path)} (.lessons/${basename(path)})${hook ? ` — ${hook}` : ""}`;
}

// The repo-relative path of `fp`, when `fp` sits in this repo or in one of its git
// worktrees (a sibling checkout whose `.git` file points into ROOT/.git). Else null.
function repoRelative(fp) {
  const rootGit = join(ROOT, ".git");
  let dir = dirname(fp);

  while (dir !== dirname(dir)) {
    const git = join(dir, ".git");

    if (existsSync(git)) {
      if (dir === ROOT) return relative(dir, fp);
      try {
        return readFileSync(git, "utf8").includes(rootGit) ? relative(dir, fp) : null;
      } catch {
        return null; // a .git directory: another repo
      }
    }
    dir = dirname(dir);
  }

  return null;
}

// ---- session-start: a short pointer, not the index -------------------------
if (mode === "session-start") {
  const count = listLessonFiles().length;

  if (!count) process.exit(0);
  emit(
    `Repo lessons: ${count} files in .lessons/ (index: .lessons/INDEX.md). ` +
      `Hooks name the matching lessons before a prompt or an edit; open a file only when it applies. ` +
      `\`/recall <topic>\` searches them, \`/learn\` adds one.`,
  );
}

// ---- prompt: keyword match against the user's request ---------------------
if (mode === "prompt") {
  let input = {};

  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    // Advisory hook, as in the sibling hooks: unreadable stdin means no lessons, not a hook error.
    process.exit(0);
  }

  const prompt = (input.prompt || "").toLowerCase();

  if (!prompt) process.exit(0);

  const words = new Set(
    prompt
      .replace(/[^a-z0-9.\-_/]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );

  const scored = [];

  for (const f of listLessonFiles()) {
    const lesson = parseLesson(f);

    const terms = [
      ...toArr(lesson.fm.keywords),
      ...toArr(lesson.fm.globs),
      ...splitWords(lesson.fm.title),
      ...splitWords(lesson.fm.symptom),
    ]
      .map((t) => String(t).toLowerCase())
      .filter(Boolean);

    const hit = new Set();

    for (const t of terms) {
      for (const w of words) {
        if (t === w || t.includes(w) || w.includes(t)) hit.add(t);
      }
    }

    if (hit.size >= 2) scored.push({ lesson, score: hit.size });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);

  if (!top.length) process.exit(0);
  emit(
    `Repo lessons that may apply (open a file only if it does):\n` +
      top.map(({ lesson }) => pointerLine(lesson)).join("\n"),
  );
}

// ---- pre-edit: glob match against the file being edited -------------------
if (mode === "pre-edit") {
  let input = {};

  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    // Advisory hook, as in the sibling hooks: unreadable stdin means no lessons, not a hook error.
    process.exit(0);
  }

  const fp = (input.tool_input && input.tool_input.file_path) || "";

  if (!fp) process.exit(0);
  const rel = repoRelative(fp);

  if (!rel) process.exit(0);
  const base = basename(rel);
  const matches = [];

  for (const f of listLessonFiles()) {
    const lesson = parseLesson(f);
    const globs = toArr(lesson.fm.globs);

    if (globs.some((g) => globMatch(g, rel) || globMatch(g, base))) matches.push(lesson);
  }

  if (!matches.length) process.exit(0);
  emit(
    `Repo lessons for ${rel} (open a file only if it applies):\n` +
      matches.slice(0, 3).map(pointerLine).join("\n"),
  );
}
