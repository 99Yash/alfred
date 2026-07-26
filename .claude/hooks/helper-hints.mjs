#!/usr/bin/env node
// Edit-time half of the consolidation rules (scripts/consolidation-rules.mjs).
//
// `pnpm check` runs the `gate` lane over files already on disk — it catches a
// hand-rolled idiom minutes after it was written. This hook runs the SAME table
// over the text an agent is about to write, so the canonical helper is named at
// the moment of the mistake instead of after it.
//
// Why this and not a bigger CLAUDE.md table: a "reach for these" table is
// push-always. It is paid by every session, is read when nothing needs it, and
// nothing keeps it in step with the code. This is push-on-match — it costs
// nothing until the agent actually types the idiom the helper replaces, and it
// cannot go stale because it reads the same rules the build gate enforces.
//
// Advisory only. It never blocks the edit: `gate` rules will fail `pnpm check`
// anyway, and `hint` rules are preferences with legacy call sites remaining.
//
// Reads PreToolUse JSON on stdin, prints hookSpecificOutput JSON, exits 0.
// Prints nothing when there is no match.

import { readFileSync } from "node:fs";

import { isSkippedPath, matchChains, matchLine } from "../../scripts/consolidation-rules.mjs";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Every chunk of text this tool call would add to the file. */
function writtenText(toolName, input) {
  if (!input) return "";
  if (toolName === "Write") return String(input.content ?? "");
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.map((e) => String(e?.new_string ?? "")).join("\n");
  }
  return String(input.new_string ?? "");
}

let payload = {};
try {
  payload = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}

const input = payload.tool_input;
const filePath = String(input?.file_path ?? "");
if (!filePath) process.exit(0);

const rel = filePath.startsWith(ROOT) ? filePath.slice(ROOT.length + 1) : filePath;
if (!/\.tsx?$/.test(rel) || isSkippedPath(rel)) process.exit(0);

const text = writtenText(String(payload.tool_name ?? ""), input);
if (!text.trim()) process.exit(0);

// One hint per rule, however many lines match it.
const hit = new Map();
for (const line of text.split("\n")) {
  for (const rule of matchLine(line, rel, "all")) {
    if (!hit.has(rule.id)) hit.set(rule.id, { rule, line: line.trim() });
  }
}
// Chain rules match across lines. This only sees the text the edit ADDS, so a
// chain the edit only partly rewrites is invisible here — that half is covered
// by the gate lane reading the file off disk in `pnpm check`.
for (const { rule, text: snippet } of matchChains(text, rel, "all")) {
  if (!hit.has(rule.id)) hit.set(rule.id, { rule, line: snippet });
}
if (hit.size === 0) process.exit(0);

const gates = [...hit.values()].filter((h) => h.rule.severity === "gate");
const hints = [...hit.values()].filter((h) => h.rule.severity === "hint");

const section = (entries, heading, note) =>
  entries.length === 0
    ? ""
    : `${heading}\n${note}\n\n${entries
        .map(({ rule, line }) => `- \`${line}\`\n  → ${rule.fix}`)
        .join("\n")}\n`;

const body = [
  `# Alfred already has a helper for this`,
  `The code you are writing to \`${rel}\` matches ${hit.size} rule(s) in \`scripts/consolidation-rules.mjs\`.`,
  ``,
  section(
    gates,
    `## Will fail \`pnpm check\``,
    `These idioms are fully consolidated to one owner, so \`check-consolidation-drift\` rejects them. Use the helper, or append \`// drift-ok\` if the exception is deliberate.`,
  ),
  section(
    hints,
    `## Preferred helper`,
    `Not gated (legacy call sites remain), but the canonical helper is better. Reach for it unless you have a reason not to.`,
  ),
]
  .filter(Boolean)
  .join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: body },
  }),
);
