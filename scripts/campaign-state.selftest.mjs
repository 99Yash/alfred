#!/usr/bin/env node
/**
 * Drives `campaign-state.mjs` against the failure it exists to prevent: two phases
 * writing two different items of one `state.json` at the same time.
 *
 * The separating drive is `concurrent set` below. It must FAIL if the lock is removed —
 * mutation-test it by deleting the `withLock` wrapper in `commandSet` and confirming this
 * goes red, because a read-modify-write that happens to interleave cleanly proves nothing.
 * The margin is real: each writer sleeps between its read and its write, which is exactly
 * the window a hand edit leaves open.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "campaign-state.mjs");
const failures = [];

function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}: ${detail}`);
}

function freshState(itemCount) {
  const dir = mkdtempSync(join(tmpdir(), "campaign-state-selftest-"));
  const statePath = join(dir, "state.json");
  const items = [];
  for (let i = 1; i <= itemCount; i += 1) {
    const id = String(i).padStart(2, "0");
    items.push({ id, slug: `item-${id}`, phase: "design", round: 0, pr: null, note: null });
  }
  writeFileSync(statePath, `${JSON.stringify({ slug: "selftest", items }, null, 2)}\n`);
  return { dir, statePath };
}

function run(args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...options }),
    };
  } catch (error) {
    // `execFileSync` throws an Error carrying the child's captured streams. The
    // assertion names the two fields this reads; the `??` still handles their absence.
    const failed = /** @type {{stdout?: string, stderr?: string}} */ (error);
    return { ok: false, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

// --- one writer: the ordinary path ----------------------------------------

{
  const { dir, statePath } = freshState(2);
  const result = run(["set", "--state", statePath, "--id", "01", "phase=review", "round=2"]);
  check("single set", result.ok, `exited non-zero: ${result.stderr ?? ""}`);
  const item = JSON.parse(readFileSync(statePath, "utf8")).items[0];
  check("single set phase", item.phase === "review", `phase is ${item.phase}`);
  check("single set round type", item.round === 2, `round is ${JSON.stringify(item.round)}`);
  check("single set stamps updatedAt", typeof item.updatedAt === "string", "updatedAt missing");
  check(
    "single set leaves the other item alone",
    JSON.parse(readFileSync(statePath, "utf8")).items[1].phase === "design",
    "item 02 moved",
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- refusals -------------------------------------------------------------

{
  const { dir, statePath } = freshState(1);
  check(
    "unknown id refused",
    !run(["set", "--state", statePath, "--id", "99", "phase=review"]).ok,
    "a set against a missing id succeeded",
  );
  check(
    "unknown phase refused",
    !run(["set", "--state", statePath, "--id", "01", "phase=lnaded"]).ok,
    "a typo'd phase was written",
  );
  check(
    "non-numeric round refused",
    !run(["set", "--state", statePath, "--id", "01", "round=soon"]).ok,
    "round accepted a non-number",
  );
  check(
    "state.json untouched by refusals",
    JSON.parse(readFileSync(statePath, "utf8")).items[0].phase === "design",
    "a refused set still wrote",
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- null and pr ----------------------------------------------------------

{
  const { dir, statePath } = freshState(1);
  run(["set", "--state", statePath, "--id", "01", "pr=764", "note=something"]);
  let item = JSON.parse(readFileSync(statePath, "utf8")).items[0];
  check("pr is a number", item.pr === 764, `pr is ${JSON.stringify(item.pr)}`);
  run(["set", "--state", statePath, "--id", "01", "note=null"]);
  item = JSON.parse(readFileSync(statePath, "utf8")).items[0];
  check("note=null writes JSON null", item.note === null, `note is ${JSON.stringify(item.note)}`);
  rmSync(dir, { recursive: true, force: true });
}

// --- the separating drive: concurrent writers to different items ----------

{
  const { dir, statePath } = freshState(8);
  // Each writer holds the lock across a deliberate read→write gap, so an unlocked
  // implementation is guaranteed to lose updates rather than merely likely to.
  const writers = JSON.parse(readFileSync(statePath, "utf8")).items.map(
    (item) =>
      new Promise((resolveWriter) => {
        const child = spawn(
          process.execPath,
          [SCRIPT, "set", "--state", statePath, "--id", item.id, "phase=landed"],
          { env: { ...process.env, CAMPAIGN_STATE_SELFTEST_DELAY_MS: "80" }, stdio: "ignore" },
        );
        child.on("exit", (code) => resolveWriter(code));
      }),
  );
  const codes = await Promise.all(writers);
  check(
    "concurrent set: every writer succeeded",
    codes.every((code) => code === 0),
    `exit codes ${JSON.stringify(codes)}`,
  );
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  const stragglers = after.items.filter((item) => item.phase !== "landed").map((item) => item.id);
  check(
    "concurrent set: no update lost",
    stragglers.length === 0,
    `items ${stragglers.join(", ")} kept phase design — a concurrent write clobbered them`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- add: id assignment and refusals -------------------------------------

{
  const { dir, statePath } = freshState(9);
  const result = run([
    "add",
    "--state",
    statePath,
    "--item-slug",
    "fence-the-door",
    "--title",
    "Fence the door",
    "--prereqs",
    "03",
  ]);
  check("add succeeds", result.ok, "add exited non-zero");
  check("add prints the id", result.stdout.includes("added item 10"), `stdout: ${result.stdout}`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const added = state.items.at(-1);
  check("add keeps the id width", added.id === "10", `id is ${added.id}`);
  check("add starts at design", added.phase === "design", `phase is ${added.phase}`);
  check("add records prereqs", added.prereqs[0] === "03", `prereqs ${added.prereqs}`);
  check(
    "add names the item file",
    result.stdout.includes("10-fence-the-door.md"),
    `stdout: ${result.stdout}`,
  );
  check(
    "unknown prereq refused",
    !run(["add", "--state", statePath, "--item-slug", "x-y", "--title", "T", "--prereqs", "99"]).ok,
    "an add with a nonexistent prereq succeeded",
  );
  check(
    "non-kebab slug refused",
    !run(["add", "--state", statePath, "--item-slug", "Not_Kebab", "--title", "T"]).ok,
    "a non-kebab item slug was accepted",
  );
  check(
    "missing title refused",
    !run(["add", "--state", statePath, "--item-slug", "no-title"]).ok,
    "an add with no title succeeded",
  );
  check(
    "refusals added nothing",
    JSON.parse(readFileSync(statePath, "utf8")).items.length === 10,
    "a refused add still appended",
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- the second separating drive: concurrent adds must not share an id ----

{
  const { dir, statePath } = freshState(4);
  const adders = [];
  const adderCount = 8;
  for (let i = 0; i < adderCount; i += 1) {
    adders.push(
      /** @type {Promise<void>} */ (
        new Promise((resolveAdder) => {
          const child = spawn(
            process.execPath,
            [
              SCRIPT,
              "add",
              "--state",
              statePath,
              "--item-slug",
              `follow-up-${i}`,
              "--title",
              `F${i}`,
            ],
            { env: { ...process.env, CAMPAIGN_STATE_SELFTEST_DELAY_MS: "80" }, stdio: "ignore" },
          );
          child.on("exit", () => resolveAdder());
        })
      ),
    );
  }
  await Promise.all(adders);
  const items = JSON.parse(readFileSync(statePath, "utf8")).items;
  const ids = items.map((item) => item.id);
  check(
    "concurrent add: every item landed",
    items.length === 4 + adderCount,
    `${items.length} items, expected ${4 + adderCount} — a concurrent add was clobbered`,
  );
  check(
    "concurrent add: no id issued twice",
    new Set(ids).size === ids.length,
    `duplicate ids in ${ids.join(", ")}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- concurrent NOTES appends --------------------------------------------

{
  const { dir, statePath } = freshState(1);
  const lineCount = 8;
  const appends = [];
  for (let i = 0; i < lineCount; i += 1) {
    appends.push(
      /** @type {Promise<void>} */ (
        new Promise((resolveAppend) => {
          const child = spawn(
            process.execPath,
            [SCRIPT, "note", "--state", statePath, `- [selftest] line ${i}`],
            { env: { ...process.env, CAMPAIGN_STATE_SELFTEST_DELAY_MS: "60" }, stdio: "ignore" },
          );
          child.on("exit", () => resolveAppend());
        })
      ),
    );
  }
  await Promise.all(appends);
  const notes = readFileSync(join(dir, "NOTES.md"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("- [selftest]"));
  check(
    "concurrent note: every line survived",
    notes.length === lineCount,
    `${notes.length} of ${lineCount} lines present`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- report ---------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write("campaign-state self-test FAILED\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}
process.stdout.write("campaign-state self-test: clean (7 drives)\n");
