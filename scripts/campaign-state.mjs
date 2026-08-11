#!/usr/bin/env node
/**
 * Serialized read-modify-write for a campaign's `state.json` and `NOTES.md`.
 *
 * Both files are whole-file rewrites of a structure every item shares, so two phases
 * running at once lose one of their updates: each reads the same bytes, edits its own
 * item, and the later write wins. That is invisible — the losing item silently keeps
 * its old `phase`, and the driver re-runs a phase that already ran.
 *
 * One campaign is one lock. A phase holds it for the milliseconds of its own write, not
 * for the phase, so lanes contend rarely and briefly.
 *
 * `mkdir` is the lock primitive: it is atomic on POSIX and needs no `flock`, which macOS
 * does not ship. The holder writes its pid so a crashed phase is diagnosable, and a lock
 * older than STALE_MS is broken rather than waited on — a phase that died mid-write must
 * not wedge every other lane behind it.
 *
 * Usage:
 *   campaign-state.mjs set  --state <path> --id <id> phase=review round=1 pr=764 note="..."
 *   campaign-state.mjs note --state <path> "- [70 design] the fact another item needs"
 *   campaign-state.mjs get  --state <path> [--id <id>]
 *
 * `--state` takes the same path the phase prompt hands the agent as `state:`.
 * `--slug <slug>` is accepted instead and resolves to `.campaign/<slug>/state.json`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 120;
const STALE_MS = 120_000;

const TERMINAL_PHASES = ["landed", "needs-human", "skipped"];
const PHASES = ["cover", "design", "implement", "review", "revise", "land", ...TERMINAL_PHASES];

/** Fields whose JSON type is not string. Anything else is written as given. */
const NUMERIC_FIELDS = ["round", "pr"];
const BOOLEAN_FIELDS = ["needsCoverage"];

function die(message) {
  process.stderr.write(`campaign-state: ${message}\n`);
  process.exit(1);
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** Parses `--flag value` pairs out of argv and returns them with the bare rest. */
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) die(`--${name} needs a value`);
      flags[name] = value;
      i += 1;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function resolveStatePath(flags) {
  if (flags.state) return resolve(flags.state);
  if (flags.slug) return join(repoRoot(), ".campaign", flags.slug, "state.json");
  die("pass --state <path/to/state.json> or --slug <campaign-slug>");
}

/**
 * Runs `body` with the campaign's lock held. The lock lives beside `state.json` so it
 * covers `NOTES.md` in the same directory too: the two files are one campaign's record,
 * and a phase that writes both must not interleave with a phase writing either.
 */
function withLock(statePath, body) {
  const lockDir = join(dirname(statePath), ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      // `mkdirSync` throws only a Node `ErrnoException`, so this reads the same
      // property the untyped version read, on the same value, and rethrows the same
      // one. The cast states that warrant; it does not create a new branch.
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // the holder released it between our mkdir and our stat
      }
      if (age > STALE_MS) {
        process.stderr.write(
          `campaign-state: breaking a stale lock (${Math.round(age / 1000)}s old) at ${lockDir}\n`,
        );
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        die(`could not take the lock at ${lockDir} within ${LOCK_TIMEOUT_MS / 1000}s`);
      }
      // Node has no sleep; block this process without spinning the CPU.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
    return body();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Widens the read→write window on demand, and only for the self-test.
 *
 * Without it the self-test's concurrent drive is not separating: eight processes racing on
 * a millisecond-long critical section can interleave cleanly by luck, so the drive would
 * pass against a lockless implementation and prove nothing. Held to the self-test by its
 * env name; nothing in the campaign sets it.
 */
function selftestDelay() {
  const ms = Number(process.env.CAMPAIGN_STATE_SELFTEST_DELAY_MS ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes through a temp file in the SAME directory, so the rename is atomic. */
function writeAtomic(path, contents) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function readState(statePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    die(
      `${statePath} is missing or unparseable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed.items)) die(`${statePath} has no items array`);
  return parsed;
}

function coerce(field, raw) {
  if (raw === "null") return null;
  if (NUMERIC_FIELDS.includes(field)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) die(`${field} must be a number or null, received ${raw}`);
    return value;
  }
  if (BOOLEAN_FIELDS.includes(field)) {
    if (raw !== "true" && raw !== "false") die(`${field} must be true or false, received ${raw}`);
    return raw === "true";
  }
  return raw;
}

function commandSet(statePath, flags, assignments) {
  const id = flags.id;
  if (!id) die("set needs --id <item-id>");
  if (assignments.length === 0) die("set needs at least one field=value");

  const updates = {};
  for (const assignment of assignments) {
    const split = assignment.indexOf("=");
    if (split < 1) die(`expected field=value, received ${assignment}`);
    const field = assignment.slice(0, split);
    updates[field] = coerce(field, assignment.slice(split + 1));
  }
  if (updates.phase !== undefined && !PHASES.includes(updates.phase)) {
    die(`unknown phase ${updates.phase} — expected one of ${PHASES.join(", ")}`);
  }

  withLock(statePath, () => {
    const state = readState(statePath);
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item) die(`no item ${id} in ${statePath}`);
    const before = `${item.phase}:${item.round ?? 0}`;
    selftestDelay();
    Object.assign(item, updates, { updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    process.stdout.write(`item ${id}: ${before} → ${item.phase}:${item.round ?? 0}\n`);
  });
}

function commandNote(statePath, lines) {
  if (lines.length === 0) die("note needs the line to append");
  const notesPath = join(dirname(statePath), "NOTES.md");
  withLock(statePath, () => {
    let existing = "";
    try {
      existing = readFileSync(notesPath, "utf8");
    } catch {
      existing = "";
    }
    selftestDelay();
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    writeAtomic(notesPath, `${existing}${separator}${lines.join("\n")}\n`);
    process.stdout.write(`appended ${lines.length} line(s) to ${notesPath}\n`);
  });
}

function commandGet(statePath, flags) {
  const state = readState(statePath);
  if (!flags.id) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  const item = state.items.find((candidate) => candidate.id === flags.id);
  if (!item) die(`no item ${flags.id} in ${statePath}`);
  process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
}

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);

switch (command) {
  case "set":
    commandSet(resolveStatePath(flags), flags, rest);
    break;
  case "note":
    commandNote(resolveStatePath(flags), rest);
    break;
  case "get":
    commandGet(resolveStatePath(flags), flags);
    break;
  default:
    die(`unknown command ${command ?? "(none)"} — expected set, note, or get`);
}
