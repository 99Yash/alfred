import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { summarizeBody, toMessage } from "@alfred/contracts";
import { z } from "zod";
import {
  ROUTE_SURFACE_CASES,
  type RouteSurfaceCase,
  routeSurfaceFor,
} from "./support/route-surface";

/**
 * Which routes `@alfred/http` mounts per `NODE_ENV`, one child process per value.
 * `.guard(hook, cb)` runs `cb` at module load, so an env read there decides the route table.
 * One process per value, because ESM caches the barrel after the first import.
 * The child env is only `PATH`, `HOME`, `TMPDIR`; a var that lets `serverEnv()` parse would hide the bug.
 * The spawn harness is a deliberate copy of `packages/assistant/test/support/import-probe-report.ts`
 * (`rootDir` blocks a shared import). Change one copy and read the other.
 */
const execFileAsync = promisify(execFile);

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHILD_PROGRAM = path.join(PACKAGE_DIR, "test/support/print-route-surface.ts");

/** A cold `tsx` load takes about 2 s; the margin is for CI. */
const CHILD_TIMEOUT_MS = 60_000;

const CHILD_OUTPUT_LIMIT_BYTES = 1_000_000;

/** Validate the child's JSON line, so a half-written report fails loud, not as a shorter list. */
const routeSurfaceReportSchema = z.array(z.string());

/** Bound for the redacted stdout excerpt in a failure message. */
const RAW_EXCERPT_LIMIT = 400;

function parseRouteSurfaceReport(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`route surface child wrote no report line; got: ${String(raw)}`);
  }

  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `route surface child wrote unparseable stdout (${toMessage(error)}): ${summarizeBody(raw, RAW_EXCERPT_LIMIT)}`,
    );
  }

  const result = routeSurfaceReportSchema.safeParse(json);

  if (!result.success) {
    throw new Error(
      `route surface child wrote a report of the wrong shape (${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}): ${summarizeBody(raw, RAW_EXCERPT_LIMIT)}`,
    );
  }

  return result.data;
}

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
