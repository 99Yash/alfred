import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

for (const behavior of ["malformed", "multiple", "oversized", "nonzero"] as const) {
  test(`a ${behavior} child reply is a dependency failure`, async () => {
    const extractPdf = testExtractor(behavior);

    await assert.rejects(
      extractPdf(new Uint8Array([1])),
      (error: unknown) => error instanceof PdfExtractionError,
    );
  });
}
