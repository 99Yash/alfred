import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { toMessage } from "@alfred/contracts";
import { z } from "zod";
import {
  ROUTE_SURFACE_CASES,
  type RouteSurfaceCase,
  routeSurfaceFor,
} from "./support/route-surface";

/**
 * Which routes `@alfred/http` mounts, as a function of `NODE_ENV`, measured one child
 * process per value.
 *
 * `.guard(hook, cb)` invokes `cb` eagerly, at module evaluation, so an environment read
 * inside an Elysia builder chain is spelled exactly like a request-scope one and decides
 * the route table before any request arrives. `../support/route-surface.ts` states the
 * expected surface per value; this suite proves the barrel agrees.
 *
 * One child per value is not a cost this suite could avoid. ESM evaluates a specifier once
 * per process, so a loop over the values inside one process would find the barrel already
 * in the module cache from value 1 and every later row would read green without having
 * measured anything.
 *
 * Each child builds its environment from scratch — `PATH` so `node` and `tsx` resolve,
 * `HOME` and `TMPDIR` because the loader writes and reads there — so the answer does not
 * depend on which job runs the suite, and no service variable can reach the barrel. Adding
 * a variable here is a real decision: a variable that lets `serverEnv()` parse would hide
 * the defect this suite exists to catch.
 */
const execFileAsync = promisify(execFile);

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_PROGRAM = path.join(PACKAGE_DIR, "test/support/print-route-surface.ts");

/** A cold `tsx` load of the whole HTTP graph measures about 2 s; the margin is for CI. */
const CHILD_TIMEOUT_MS = 60_000;
const CHILD_OUTPUT_LIMIT_BYTES = 1_000_000;

/**
 * The child writes one JSON line and this is the owning boundary for it. The line is
 * protocol data crossing a process boundary, so it is validated rather than asserted: a
 * child that dies mid-write, or that prints a `tsx` diagnostic, must fail as an unreadable
 * child and never as a shorter route list.
 */
const routeSurfaceReportSchema = z.array(z.string());

/** Keeps a failure message readable when the child printed a stack trace instead of JSON. */
const RAW_EXCERPT_LIMIT = 400;

function excerpt(raw: string): string {
  return raw.length > RAW_EXCERPT_LIMIT ? `${raw.slice(0, RAW_EXCERPT_LIMIT)}…` : raw;
}

function parseRouteSurfaceReport(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`route surface child wrote no report line; got: ${String(raw)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `route surface child wrote unparseable stdout (${toMessage(error)}): ${excerpt(raw)}`,
    );
  }

  const result = routeSurfaceReportSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `route surface child wrote a report of the wrong shape (${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}): ${excerpt(raw)}`,
    );
  }
  return result.data;
}

/** Spawns one child under `testCase`'s environment and returns the surface it mounted. */
async function routeSurfaceUnder(testCase: RouteSurfaceCase): Promise<readonly string[]> {
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  if (testCase.nodeEnv !== undefined) childEnv.NODE_ENV = testCase.nodeEnv;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ["--import", "tsx", CHILD_PROGRAM], {
      cwd: PACKAGE_DIR,
      env: childEnv,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: CHILD_OUTPUT_LIMIT_BYTES,
      encoding: "utf8",
    }));
  } catch (error) {
    throw new Error(
      `route surface child failed for NODE_ENV ${testCase.label}: ${toMessage(error)}`,
    );
  }
  return parseRouteSurfaceReport(stdout);
}

describe("@alfred/http route surface across NODE_ENV", () => {
  for (const testCase of ROUTE_SURFACE_CASES) {
    test(`mounts the expected routes when NODE_ENV is ${testCase.label}`, async () => {
      assert.deepEqual(
        await routeSurfaceUnder(testCase),
        routeSurfaceFor(testCase),
        `NODE_ENV ${testCase.label} mounts a different route surface than the table declares`,
      );
    });
  }
});
