// A `node --test` reporter that writes one JSON object: test file -> wall milliseconds.
//
// `node --test` runs each file in its own child process and reports the file
// itself as a top-level test whose name is the file path relative to the cwd.
// Its `test:complete` duration covers the child from spawn to exit, so it
// includes the module-graph load. That load is most of the cost here (about
// 1.1 CPU-s per `test/tool-runtime` file), and no per-test duration counts it.
//
// CI runs it beside the spec reporter (see `run-test-shard.mjs`) on the real
// runner, with Postgres and Redis. A local run skips the DB-backed suites, so
// local times are not weights. `test-shard-weights.mjs` merges the CI output into
// the committed `test/shard-weights.json`.

import { relative, sep } from "node:path";

/**
 * @param {AsyncIterable<import("node:test/reporters").TestEvent>} source
 * @returns {AsyncGenerator<string, void>}
 */
export default async function* testFileDurations(source) {
  /** @type {Map<string, number>} */
  const durations = new Map();

  for await (const event of source) {
    if (event.type !== "test:complete") continue;
    const { data } = event;

    if (data.nesting !== 0 || data.file === undefined) continue;
    const file = relative(process.cwd(), data.file).split(sep).join("/");

    // A top-level `test()` or `describe()` inside the file has the same
    // nesting and file; only the file-level entry is named by its path.
    if (data.name !== file) continue;
    durations.set(file, Math.round(data.details.duration_ms));
  }

  const sorted = Object.fromEntries([...durations].toSorted(([a], [b]) => a.localeCompare(b)));
  yield `${JSON.stringify(sorted, null, 2)}\n`;
}
