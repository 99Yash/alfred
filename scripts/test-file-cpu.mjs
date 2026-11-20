// A preload (`--import`) that records the CPU time of one `node --test` file.
//
// `node --test` runs each test file in its own child and passes its `--import`
// flags on to that child. So this module runs once in every file's process.
// When `TEST_CPU_OUT` is set, it appends one JSON line at exit:
// `{"file":"test/x.test.ts","ms":1234}`.
//
// It records CPU, not wall time. A file's wall time under `node --test`
// concurrency mostly says which files shared the CPU with it: across two CI
// runs the same file moved from 4.8 s to 15.9 s. CPU time does not depend on
// the neighbours. It also counts what a file spawns. `test/barrel-load.test.ts`
// starts one `tsx` child per exports subpath (79 of them): 16 s of wall time but
// 116 CPU-s, about 20 % of the suite's CPU, on 2026-11-20.
//
// The `ms` is the process's own CPU (`process.cpuUsage()`) plus, on Linux, the
// CPU of every child it has waited for (`cutime` + `cstime` in `/proc/self/stat`,
// which accumulates through grandchildren). Off Linux the child term is 0, so a
// local run undercounts a file that spawns. CI runs on Linux.
//
// The test runner's own process loads this module too. It records nothing,
// because its entry script is not a `.test.ts` file.

import { appendFileSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";

/** `/proc` reports these fields in clock ticks; x86_64 Linux uses 100 per second. */
const TICKS_PER_SECOND = 100;

const out = process.env["TEST_CPU_OUT"];

const entry = process.argv.at(1);

/**
 * CPU milliseconds of the children this process has waited for, or 0 off Linux.
 *
 * @returns {number}
 */
function waitedChildrenCpuMs() {
  let stat;

  try {
    stat = readFileSync("/proc/self/stat", "utf8");
  } catch {
    return 0;
  }

  // Fields after the `(comm)` field, which may hold spaces. Field 3 is index 0,
  // so cutime (field 16) and cstime (field 17) are indexes 13 and 14.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[13]) + Number(fields[14]);

  return Number.isFinite(ticks) ? (ticks * 1000) / TICKS_PER_SECOND : 0;
}

if (out !== undefined && out !== "" && entry?.endsWith(".test.ts") === true) {
  const file = relative(process.cwd(), entry).split(sep).join("/");

  process.on("exit", () => {
    const self = process.cpuUsage();
    const ms = Math.round((self.user + self.system) / 1000 + waitedChildrenCpuMs());

    appendFileSync(out, `${JSON.stringify({ file, ms })}\n`);
  });
}
