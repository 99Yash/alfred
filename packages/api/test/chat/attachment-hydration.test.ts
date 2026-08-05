import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_MODEL_ATTACHMENT_BYTES_PER_TURN,
  type AgentTranscriptMessage,
} from "@alfred/contracts";

import {
  buildStoredContentParts,
  hydrateTranscriptForModel,
  type StoredObjectReader,
} from "../../src/modules/conversations/chat-attachments";

/**
 * Direct coverage for the ADR-0065 per-turn image budget, which had none while
 * it lived inside `chat-turn.ts`: it could only be exercised through a live
 * model turn with real object storage, so every accounting bug was a production
 * bug. With the object reader injected, the budget and its three distinct skip
 * reasons (over-budget / unreadable / invalid) are ordinary unit tests.
 *
 * The invariant that matters in production: an image that cannot be inlined is
 * REPLACED by a text part saying so, never silently dropped. A silently dropped
 * image is how the boss ends up confidently describing a picture it never saw.
 */

/** A minimal valid PNG header, enough for `sniffPassThroughImageMime`. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(PNG_MAGIC.slice(0, Math.min(PNG_MAGIC.length, totalBytes)));
  return bytes;
}

/** The stored (pre-hydration) shape `buildStoredContentParts` emits for an image. */
function storedImage(storageKey: string, byteSize?: number): Record<string, unknown> {
  return {
    type: "chat_attachment_image",
    storageKey,
    mediaType: "image/png",
    ...(byteSize === undefined ? {} : { byteSize }),
  };
}

function userMessage(content: unknown): AgentTranscriptMessage {
  return { role: "user", content } as AgentTranscriptMessage;
}

function readerFor(objects: Record<string, Uint8Array>): StoredObjectReader {
  return async (storageKey) => {
    const bytes = objects[storageKey];
    if (!bytes) throw new Error(`no such object: ${storageKey}`);
    return bytes;
  };
}

function textParts(content: unknown): string[] {
  assert.ok(Array.isArray(content), "hydrated content should stay a parts array");
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
      );
    })
    .map((part) => part.text);
}

function filePartCount(content: unknown): number {
  assert.ok(Array.isArray(content));
  return content.filter(
    (part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "file",
  ).length;
}

describe("chat attachment hydration — per-turn byte budget", () => {
  test("inlines an image as a base64 file part and charges its encoded size", async () => {
    const raw = pngBytes(3_000);
    const { transcript, budget } = await hydrateTranscriptForModel(
      [userMessage([{ type: "text", text: "what is this" }, storedImage("k1", raw.byteLength)])],
      readerFor({ k1: raw }),
    );

    const content = transcript[0]?.content;
    assert.equal(filePartCount(content), 1);
    assert.deepEqual(textParts(content), ["what is this"]);
    // Base64 expands 3 bytes to 4 characters; the budget counts the encoded size,
    // which is what actually rides the request.
    assert.equal(budget.usedEncodedBytes, 4_000);
    assert.equal(budget.skippedImages, 0);
  });

  test("reads each storage key once even when the same image repeats", async () => {
    const raw = pngBytes(3_000);
    let reads = 0;
    const { budget } = await hydrateTranscriptForModel(
      [
        userMessage([storedImage("same", raw.byteLength)]),
        userMessage([storedImage("same", raw.byteLength)]),
      ],
      async (key) => {
        reads += 1;
        assert.equal(key, "same");
        return raw;
      },
    );

    assert.equal(reads, 1, "the hydration cache serves the repeat");
    // Cached or not, each inlined copy still costs the model its own bytes.
    assert.equal(budget.usedEncodedBytes, 8_000);
  });

  test("a declared byteSize over budget is skipped without reading the object", async () => {
    let reads = 0;
    const { transcript, budget } = await hydrateTranscriptForModel(
      [userMessage([storedImage("huge", MAX_MODEL_ATTACHMENT_BYTES_PER_TURN)])],
      async () => {
        reads += 1;
        return pngBytes(8);
      },
    );

    assert.equal(reads, 0, "an image already known to overflow is never fetched");
    assert.equal(budget.skippedImages, 1);
    assert.equal(budget.usedEncodedBytes, 0);
    assert.equal(filePartCount(transcript[0]?.content), 0);
    assert.deepEqual(textParts(transcript[0]?.content), [
      "[Image attachment omitted because the image context budget is full.]",
    ]);
  });

  test("an undeclared oversize image is caught by the post-read budget check", async () => {
    // No `byteSize`, so the projection check cannot fire — only the re-check
    // against the real encoded size stops this one.
    const raw = pngBytes(MAX_MODEL_ATTACHMENT_BYTES_PER_TURN);
    const { transcript, budget } = await hydrateTranscriptForModel(
      [userMessage([storedImage("undeclared")])],
      readerFor({ undeclared: raw }),
    );

    assert.equal(budget.skippedImages, 1);
    assert.equal(budget.usedEncodedBytes, 0, "an over-budget image is never charged");
    assert.equal(filePartCount(transcript[0]?.content), 0);
  });

  test("newest messages win the budget; older images degrade to a text note", async () => {
    // Two images, each just over half the budget: only one can fit.
    const halfPlus = Math.ceil((MAX_MODEL_ATTACHMENT_BYTES_PER_TURN * 3) / 4 / 2) + 1_000;
    const older = pngBytes(halfPlus);
    const newer = pngBytes(halfPlus);
    const { transcript, budget } = await hydrateTranscriptForModel(
      [
        userMessage([{ type: "text", text: "older" }, storedImage("older", older.byteLength)]),
        userMessage([{ type: "text", text: "newer" }, storedImage("newer", newer.byteLength)]),
      ],
      readerFor({ older, newer }),
    );

    assert.equal(budget.skippedImages, 1);
    assert.equal(
      filePartCount(transcript[1]?.content),
      1,
      "the latest turn's image — the one the user is most likely asking about — survives",
    );
    assert.equal(filePartCount(transcript[0]?.content), 0);
    assert.deepEqual(textParts(transcript[0]?.content), [
      "older",
      "[Image attachment omitted because the image context budget is full.]",
    ]);
    assert.equal(transcript.length, 2, "messages come back in their original order");
  });

  test("an unreadable object is reported as unreadable, not as invalid or over-budget", async () => {
    const { transcript, budget } = await hydrateTranscriptForModel(
      [userMessage([storedImage("gone", 3_000)])],
      readerFor({}),
    );

    assert.equal(budget.unreadableImages, 1);
    assert.equal(budget.invalidImages, 0);
    assert.equal(budget.skippedImages, 0);
    assert.deepEqual(textParts(transcript[0]?.content), [
      "[Image attachment omitted because it could not be read.]",
    ]);
  });

  test("bytes that are not a supported image are reported as invalid", async () => {
    // No `mediaType` on the part, so the mime is sniffed from the bytes — and
    // these are not an image.
    const { transcript, budget } = await hydrateTranscriptForModel(
      [userMessage([{ type: "chat_attachment_image", storageKey: "junk" }])],
      readerFor({ junk: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }),
    );

    assert.equal(budget.invalidImages, 1);
    assert.equal(budget.unreadableImages, 0);
    assert.deepEqual(textParts(transcript[0]?.content), [
      "[Image attachment omitted because it could not be processed.]",
    ]);
  });

  test("a skipped image never leaves the turn short a part", async () => {
    const raw = pngBytes(3_000);
    const { transcript } = await hydrateTranscriptForModel(
      [
        userMessage([
          storedImage("ok", raw.byteLength),
          storedImage("over", MAX_MODEL_ATTACHMENT_BYTES_PER_TURN),
          storedImage("missing", 3_000),
        ]),
      ],
      readerFor({ ok: raw }),
    );

    const content = transcript[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.length, 3, "every stored image contributes exactly one part");
    assert.equal(filePartCount(content), 1);
    assert.equal(textParts(content).length, 2);
  });

  test("a message with no attachments passes through untouched", async () => {
    const plain = userMessage("just text");
    const { transcript, budget } = await hydrateTranscriptForModel([plain], readerFor({}));

    assert.equal(transcript[0]?.content, "just text");
    assert.equal(budget.usedEncodedBytes, 0);
  });
});

describe("buildStoredContentParts", () => {
  test("a pass-through image is stored as a key, never as bytes", () => {
    const parts = buildStoredContentParts("look", [
      {
        id: "att_1",
        storageKey: "key_1",
        mime: "image/png",
        size: 2_048,
        degradedText: null,
        degradedImageKeys: [],
      },
    ]);

    assert.deepEqual(parts, [
      { type: "text", text: "look" },
      {
        type: "chat_attachment_image",
        storageKey: "key_1",
        attachmentId: "att_1",
        mediaType: "image/png",
        byteSize: 2_048,
      },
    ]);
  });

  test("a degraded modality contributes its extracted text plus keyframe keys", () => {
    const parts = buildStoredContentParts("", [
      {
        id: "att_2",
        storageKey: "key_2",
        mime: "application/pdf",
        size: 900_000,
        degradedText: "page one",
        degradedImageKeys: ["frame_a", "frame_b"],
      },
    ]);

    assert.deepEqual(parts, [
      { type: "text", text: "page one" },
      { type: "chat_attachment_image", storageKey: "frame_a" },
      { type: "chat_attachment_image", storageKey: "frame_b" },
    ]);
  });

  test("an attachment that degraded to nothing contributes nothing", () => {
    const parts = buildStoredContentParts("", [
      {
        id: "att_3",
        storageKey: "key_3",
        mime: "application/zip",
        size: 10,
        degradedText: "",
        degradedImageKeys: [],
      },
    ]);

    assert.deepEqual(parts, [], "the caller drops the turn when nothing renderable is produced");
  });
});
