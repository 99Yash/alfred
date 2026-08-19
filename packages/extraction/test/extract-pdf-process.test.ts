import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  createPdfExtractor,
  createPdfExtractorWithChild,
  PdfExtractionError,
  type PdfExtractionLimits,
} from "../src/extract-pdf";

const CHILD_ENTRY = new URL("./support/extract-pdf-process-child.ts", import.meta.url);
const BASE_LIMITS: PdfExtractionLimits = {
  maxBytes: 1_000,
  maxCharacters: 10,
  maxParseMilliseconds: 300,
};

function testExtractor(
  behavior: string,
  limits: PdfExtractionLimits = BASE_LIMITS,
  onSpawn?: (pid: number | undefined) => void,
) {
  return createPdfExtractorWithChild(limits, {
    childEntry: CHILD_ENTRY,
    env: { PDF_EXTRACTION_TEST_BEHAVIOR: behavior },
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
  const extractPdf = testExtractor("nonzero_late_close");

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause instanceof Error &&
      error.cause.message.includes("exited with code 7"),
  );
  assert.ok(performance.now() - startedAt < 800);
});

test("oversized output remains the terminal cause when inherited pipes delay close", async () => {
  const startedAt = performance.now();
  const extractPdf = testExtractor("oversized_late_close");

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof PdfExtractionError &&
      error.cause instanceof Error &&
      error.cause.message === "PDF extraction child exceeded the bounded stdout protocol",
  );
  assert.ok(performance.now() - startedAt < 800);
});

test("a deadline settles after a code-zero child leaves inherited pipes open", async () => {
  const startedAt = performance.now();
  const extractPdf = testExtractor("valid_late_close");

  const result = await extractPdf(new Uint8Array([1]));

  assert.equal(result.kind, "limit_exceeded");
  if (result.kind !== "limit_exceeded") return;
  assert.equal(result.limit, "parse_milliseconds");
  assert.ok(performance.now() - startedAt < 800);
});

test("malformed output wins when a code-zero child's inherited pipes cross the deadline", async () => {
  const startedAt = performance.now();
  const extractPdf = testExtractor("malformed_late_close");

  await assert.rejects(
    extractPdf(new Uint8Array([1])),
    (error: unknown) => error instanceof PdfExtractionError,
  );
  assert.ok(performance.now() - startedAt < 800);
});

test("a backward wall-clock adjustment does not extend the parse deadline", async () => {
  const originalDateNow = Date.now;
  const startedAt = performance.now();
  const extractPdf = createPdfExtractorWithChild(BASE_LIMITS, {
    childEntry: CHILD_ENTRY,
    env: { PDF_EXTRACTION_TEST_BEHAVIOR: "hang" },
    spawnChild: (spawnDefault) => {
      Date.now = () => originalDateNow() - 1_000;
      return spawnDefault();
    },
  });

  try {
    const result = await extractPdf(new Uint8Array([1]));

    assert.equal(result.kind, "limit_exceeded");
    if (result.kind !== "limit_exceeded") return;
    assert.equal(result.limit, "parse_milliseconds");
    assert.ok(performance.now() - startedAt < 800);
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
