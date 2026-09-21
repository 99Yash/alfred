import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  createPdfExtractor,
  createPdfExtractorWithChild,
  PdfExtractionError,
} from "../src/extract-pdf";
import type { PdfExtractionLimits } from "../src/constants";

const CHILD_ENTRY = new URL("./support/extract-pdf-process-child.ts", import.meta.url);

/**
 * The deadline clock starts at spawn, and a cold `tsx` child needs a few
 * hundred milliseconds to boot. So a default deadline in that same range makes
 * every case that asserts a CHILD-produced outcome race its own clock, and the
 * race is silent in the direction that reads as success: the deadline wins,
 * `extractPdf` RESOLVES with a `parse_milliseconds` limit, and the expected
 * rejection simply never arrives. The default is therefore out of reach, and
 * each case that needs the deadline to fire names its own value below.
 */
const BASE_LIMITS: PdfExtractionLimits = {
  maxBytes: 1_000,
  maxCharacters: 10,
  maxParseMilliseconds: 10_000,
};

/**
 * How long a `*_late_close` child holds the inherited stdout open after its own
 * exit. The parent settles on `close` and on nothing else, so this is the delay
 * each late-close case is measured against. The child reads it from the
 * environment; see `holdInheritedPipes` in the child fixture.
 */
const PIPE_HOLD_MILLISECONDS = 5_000;

/**
 * The deadline for a case where the child records a terminal cause of its own
 * and the held-open pipe then delays `close`. Two bounds, both load-bearing:
 * ABOVE child startup, so the child's cause lands first and survives, and BELOW
 * {@link PIPE_HOLD_MILLISECONDS}, because the deadline is what destroys the
 * streams and lets `close` arrive at all.
 */
const DEADLINE_INSIDE_PIPE_HOLD_MILLISECONDS = 1_200;

/**
 * The deadline for a case whose child never produces a usable reply, so the
 * deadline is the only outcome available however slowly the child boots.
 */
const DEADLINE_ALWAYS_WINS_MILLISECONDS = 300;

/**
 * Settling this early proves the parent did not sit and wait for the held-open
 * pipe. The margin against {@link PIPE_HOLD_MILLISECONDS} is what makes the
 * claim survive a loaded machine.
 */
const SETTLED_WITHOUT_THE_PIPE_HOLD_MILLISECONDS = 3_000;

function testExtractor(
  behavior: string,
  limits: PdfExtractionLimits = BASE_LIMITS,
  onSpawn?: (pid: number | undefined) => void,
) {
  return createPdfExtractorWithChild(limits, {
    childEntry: CHILD_ENTRY,
    env: {
      PDF_EXTRACTION_TEST_BEHAVIOR: behavior,
      PDF_EXTRACTION_TEST_HOLD_MILLISECONDS: String(PIPE_HOLD_MILLISECONDS),
    },
    ...(onSpawn === undefined ? {} : { onSpawn }),
  });
}

test("all configured limits must be positive safe integers", () => {
  for (const key of ["maxBytes", "maxCharacters", "maxParseMilliseconds"] as const) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => createPdfExtractor({ ...BASE_LIMITS, [key]: value }),
        (error: unknown) => error instanceof RangeError && error.message.includes(key),
      );
    }
  }
});

test("the parse deadline stays within Node's timer range", () => {
  assert.doesNotThrow(() =>
    createPdfExtractor({ ...BASE_LIMITS, maxParseMilliseconds: 2_147_483_647 }),
  );
  assert.throws(
    () => createPdfExtractor({ ...BASE_LIMITS, maxParseMilliseconds: 2_147_483_648 }),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message === "maxParseMilliseconds must be at most 2147483647",
  );
});

test("an input-byte breach returns before a child starts", async () => {
  let spawnCount = 0;

  const extractPdf = testExtractor("hang", { ...BASE_LIMITS, maxBytes: 1 }, () => {
    spawnCount += 1;
  });

  const result = await extractPdf(new Uint8Array([1, 2]));

  assert.deepEqual(result, {
    kind: "limit_exceeded",
    limit: "input_bytes",
    actual: 2,
    maximum: 1,
    message: "PDF input byte limit exceeded: 2 > 1",
  });
  assert.equal(spawnCount, 0);
});

test("a parse deadline kills the child after unrelated parent work completes", async () => {
  let childPid: number | undefined;

  const extractPdf = testExtractor("hang", { ...BASE_LIMITS, maxParseMilliseconds: 500 }, (pid) => {
    childPid = pid;
  });

  const extraction = extractPdf(new Uint8Array([1]));
  const timer = new Promise<void>((resolve) => setTimeout(resolve, 10));
  const fileRead = readFile(new URL("./fixtures/not-a-pdf.bin", import.meta.url));

  await Promise.all([timer, fileRead]);
  const result = await extraction;

  assert.equal(result.kind, "limit_exceeded");

  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "parse_milliseconds");
  assert.equal(result.maximum, 500);
  assert.ok(result.actual >= 500);
  assert.notEqual(childPid, undefined);
  assert.throws(
    () => process.kill(childPid ?? 0, 0),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
  );
});

test("the parse deadline includes synchronous process startup", async () => {
  const startupDelayMilliseconds = 300;
  const maxParseMilliseconds = 500;

  const extractPdf = createPdfExtractorWithChild(
    { ...BASE_LIMITS, maxParseMilliseconds },
    {
      childEntry: CHILD_ENTRY,
      env: { PDF_EXTRACTION_TEST_BEHAVIOR: "hang" },
      spawnChild: (spawnDefault) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupDelayMilliseconds);

        return spawnDefault();
      },
    },
  );

  const result = await extractPdf(new Uint8Array([1]));

  assert.equal(result.kind, "limit_exceeded");

  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "parse_milliseconds");
  assert.equal(result.maximum, maxParseMilliseconds);
  assert.ok(result.actual >= maxParseMilliseconds);
  assert.ok(result.actual < startupDelayMilliseconds + maxParseMilliseconds);
});

test("a synchronous spawn failure is a PDF extraction failure", async () => {
  const failure = Object.assign(new Error("synthetic spawn failure"), {
    code: "E_SYNTHETIC_SPAWN",
  });

  const extractPdf = createPdfExtractorWithChild(BASE_LIMITS, {
    childEntry: CHILD_ENTRY,
    spawnChild: () => {
      throw failure;
    },
  });

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause === failure &&
      error.message.includes("(code: E_SYNTHETIC_SPAWN): synthetic spawn failure"),
  );
});

test("a remote extraction failure keeps the canonical diagnostic message", async () => {
  const extractPdf = testExtractor("dependency_error");

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause instanceof Error &&
      error.cause.name === "SyntheticVendorError" &&
      error.message ===
        "@alfred/extraction: @firecrawl/pdf-inspector failed with an error this package does not map" +
          " (code: E_SYNTHETIC): synthetic vendor failure",
  );
});

test("a process failure remains the terminal cause when close crosses the deadline", async () => {
  const failure = new Error("synthetic near-deadline process failure");

  const extractPdf = createPdfExtractorWithChild(
    { ...BASE_LIMITS, maxParseMilliseconds: 500 },
    {
      childEntry: CHILD_ENTRY,
      env: { PDF_EXTRACTION_TEST_BEHAVIOR: "hang" },
      spawnChild: (spawnDefault) => {
        const child = spawnDefault();
        setTimeout(() => child.emit("error", failure), 450);

        return child;
      },
      killChild: (child) => {
        setTimeout(() => child.kill("SIGKILL"), 100);
      },
    },
  );

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) => error instanceof PdfExtractionError && error.cause === failure,
  );
});

test("a non-zero exit remains the terminal cause when inherited pipes delay close", async () => {
  const startedAt = performance.now();

  const extractPdf = testExtractor("nonzero_late_close", {
    ...BASE_LIMITS,
    maxParseMilliseconds: DEADLINE_INSIDE_PIPE_HOLD_MILLISECONDS,
  });

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause instanceof Error &&
      error.cause.message.includes("exited with code 7"),
  );
  assert.ok(performance.now() - startedAt < SETTLED_WITHOUT_THE_PIPE_HOLD_MILLISECONDS);
});

test("oversized output remains the terminal cause when inherited pipes delay close", async () => {
  const startedAt = performance.now();

  const extractPdf = testExtractor("oversized_late_close", {
    ...BASE_LIMITS,
    maxParseMilliseconds: DEADLINE_INSIDE_PIPE_HOLD_MILLISECONDS,
  });

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause instanceof Error &&
      error.cause.message === "PDF extraction child exceeded the bounded stdout protocol",
  );
  assert.ok(performance.now() - startedAt < SETTLED_WITHOUT_THE_PIPE_HOLD_MILLISECONDS);
});

test("a deadline settles after a code-zero child leaves inherited pipes open", async () => {
  const startedAt = performance.now();

  const extractPdf = testExtractor("valid_late_close", {
    ...BASE_LIMITS,
    maxParseMilliseconds: DEADLINE_ALWAYS_WINS_MILLISECONDS,
  });

  const result = await extractPdf(new Uint8Array([1]));

  assert.equal(result.kind, "limit_exceeded");

  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "parse_milliseconds");
  assert.ok(performance.now() - startedAt < SETTLED_WITHOUT_THE_PIPE_HOLD_MILLISECONDS);
});

test("malformed output wins when a code-zero child's inherited pipes cross the deadline", async () => {
  const startedAt = performance.now();

  const extractPdf = testExtractor("malformed_late_close", {
    ...BASE_LIMITS,
    maxParseMilliseconds: DEADLINE_INSIDE_PIPE_HOLD_MILLISECONDS,
  });

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    // The malformed REPLY must be the cause. `instanceof PdfExtractionError`
    // alone cannot tell this apart from a child that died for any other reason,
    // which is how the case stays green even when the fixture never held a pipe.
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause instanceof Error &&
      error.cause.message === "PDF extraction child reply is not valid JSON",
  );
  assert.ok(performance.now() - startedAt < SETTLED_WITHOUT_THE_PIPE_HOLD_MILLISECONDS);
});

test("a backward wall-clock adjustment does not extend the parse deadline", async () => {
  const originalDateNow = Date.now;
  const startedAt = performance.now();

  const extractPdf = createPdfExtractorWithChild(
    { ...BASE_LIMITS, maxParseMilliseconds: DEADLINE_ALWAYS_WINS_MILLISECONDS },
    {
      childEntry: CHILD_ENTRY,
      env: { PDF_EXTRACTION_TEST_BEHAVIOR: "hang" },
      spawnChild: (spawnDefault) => {
        Date.now = () => originalDateNow() - 1_000;

        return spawnDefault();
      },
    },
  );

  try {
    const result = await extractPdf(new Uint8Array([1]));

    assert.equal(result.kind, "limit_exceeded");

    if (result.kind !== "limit_exceeded") return;
    assert.equal(result.limit, "parse_milliseconds");
    assert.ok(performance.now() - startedAt < SETTLED_WITHOUT_THE_PIPE_HOLD_MILLISECONDS);
  } finally {
    Date.now = originalDateNow;
  }
});

for (const behavior of ["invalid_limit_equal", "invalid_limit_message"] as const) {
  test(`an ${behavior} child reply is a dependency failure`, async () => {
    const extractPdf = testExtractor(behavior);

    await assert.rejects(
      extractPdf(new Uint8Array([1])),
      (error: unknown) => error instanceof PdfExtractionError,
    );
  });
}

for (const behavior of ["malformed", "multiple", "oversized", "nonzero"] as const) {
  test(`a ${behavior} child reply is a dependency failure`, async () => {
    const extractPdf = testExtractor(behavior);

    await assert.rejects(
      extractPdf(new Uint8Array([1])),
      (error: unknown) => error instanceof PdfExtractionError,
    );
  });
}
