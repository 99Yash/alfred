// The one rule that splits a package's test files across CI legs by measured weight.
//
// `node --test-shard=i/n` deals the SORTED file list round-robin and knows nothing
// about cost. In `@alfred/assistant` that put the heavy files on leg 1 run after
// run: 135 s of test time against 71 s and 74 s on legs 2 and 3, over 12 green
// runs on 2026-11-20. This module deals by weight instead. It sorts the files
// heaviest first and gives each file to the leg with the least weight so far (the
// LPT rule). The weights are per-file wall times that CI recorded with
// `test-file-durations.mjs`, committed as `test/shard-weights.json` in the package.
//
// Coverage never depends on the weights. The file list comes from git, so a new
// test file always runs: it takes the median weight until the next refresh. A
// stale or missing weights file can only make the legs uneven.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";

/** Where a package keeps its weights, relative to the package directory. */
export const WEIGHTS_FILE = "test/shard-weights.json";

/**
 * Every `*.test.ts` file under `test/` of the package at `cwd`, relative to `cwd`.
 * This is the set the old `"test/**\/*.test.ts"` glob matched.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function listTestFiles(cwd) {
  return listGitSourceFiles(["test"], cwd).filter((file) => file.endsWith(".test.ts"));
}

/**
 * `"2/3"` as `{ index: 2, total: 3 }`, or null when the text is not `i/n` with
 * `1 <= i <= n`.
 *
 * @param {string | undefined} text
 * @returns {{ index: number; total: number } | null}
 */
export function parseShardSpec(text) {
  const match = /^(\d+)\/(\d+)$/.exec(text ?? "");

  if (match === null) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);

  return index >= 1 && index <= total ? { index, total } : null;
}

/**
 * The committed weights of the package at `cwd`, in milliseconds per file. An
 * absent file is an empty map: every file then takes the same weight.
 *
 * @param {string} cwd
 * @returns {Map<string, number>}
 */
export function readWeights(cwd) {
  const path = resolve(cwd, WEIGHTS_FILE);

  if (!existsSync(path)) return new Map();
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(path, "utf8"));

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- parses a committed JSON file at its read; a wrong shape throws
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object of file -> milliseconds`);
  }

  /** @type {Map<string, number>} */
  const weights = new Map();

  for (const [file, value] of Object.entries(parsed)) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- parses a committed JSON file at its read; a wrong shape throws
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${path}: the weight of ${file} is not a non-negative number`);
    }

    weights.set(file, value);
  }

  return weights;
}

/**
 * @typedef {{ files: string[]; weight: number }} Leg
 */

/**
 * Splits `files` into `total` legs of near-equal summed weight. The result is
 * deterministic for one input: ties break on the file path and on the lower leg.
 * A file with no weight takes the median of the files that have one.
 *
 * @param {readonly string[]} files
 * @param {ReadonlyMap<string, number>} weights
 * @param {number} total
 * @returns {{ legs: Leg[]; unweighted: string[] }}
 */
export function assignShards(files, weights, total) {
  const known = files.flatMap((file) => {
    const weight = weights.get(file);

    return weight === undefined ? [] : [weight];
  });

  const sortedKnown = known.toSorted((a, b) => a - b);
  const fallback = sortedKnown.length === 0 ? 1 : sortedKnown[Math.floor(sortedKnown.length / 2)];
  const unweighted = files.filter((file) => !weights.has(file));

  const heaviestFirst = files
    .map((file) => ({ file, weight: weights.get(file) ?? fallback }))
    .toSorted((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  /** @type {Leg[]} */
  const legs = Array.from({ length: total }, () => ({ files: [], weight: 0 }));

  for (const item of heaviestFirst) {
    const lightest = legs.reduce((min, leg) => (leg.weight < min.weight ? leg : min));
    lightest.files.push(item.file);
    lightest.weight += item.weight;
  }

  for (const leg of legs) leg.files.sort();

  return { legs, unweighted };
}
