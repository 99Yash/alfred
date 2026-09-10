import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { identifyLanguageModel } from "../src/models";
import { getMediaEnrichmentModels } from "../src/provider";

function modelIds(modality: "image" | "audio" | "video" | "pdf", byteSize: number): string[] {
  return getMediaEnrichmentModels(modality, byteSize).map(
    (model) => identifyLanguageModel(model).modelId,
  );
}

describe("media enrichment routing", () => {
  test("routes images through both Flash models, Flash-Lite, then Sonnet", () => {
    assert.deepEqual(modelIds("image", 1_000), [
      "gemini-3.8-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "claude-sonnet-4-6",
    ]);
  });

  test("skips 2.5-flash for PDF input it does not advertise", () => {
    assert.deepEqual(modelIds("pdf", 1_000), [
      "gemini-3.8-flash",
      "gemini-2.5-flash-lite",
      "claude-sonnet-4-6",
    ]);
  });

  test("rejects payloads beyond every compatible inline limit", () => {
    assert.throws(
      () => getMediaEnrichmentModels("video", 60 * 1024 * 1024),
      /media_enrichment_input_unsupported/,
    );
  });
});
