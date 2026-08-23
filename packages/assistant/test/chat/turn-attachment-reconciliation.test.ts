import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  attachmentRequestMatchesExistingRows,
  freshAttachmentRowsMatchSubset,
  sameInsertedAttachmentRows,
  type ExistingAttachmentSummary,
  type FreshAttachmentDescriptor,
  type RetryAttachmentSource,
} from "@alfred/assistant/chat/turn-attachment-reconciliation";
import type { NewChatAttachment } from "@alfred/db/schemas";

/**
 * The three predicates that decide whether a resent chat turn is the SAME turn.
 *
 * `startChatTurn` calls them on every resend of a `userMessageId` that already
 * has rows: a match returns the run that already exists, a mismatch throws
 * `ConflictError("Message id already belongs to a different chat turn")`. So a
 * predicate that is too loose accepts a changed attachment set under an old id,
 * and one that is too strict 409s an honest client retry. They are pure over
 * rows — no database, no Redis, no storage — so they are the one seam of the
 * turn-admission move that a service-free suite can pin.
 */

function summary(
  id: string,
  overrides: Partial<ExistingAttachmentSummary> = {},
): ExistingAttachmentSummary {
  return { id, name: `${id}.png`, mime: "image/png", size: 100, position: 0, ...overrides };
}

function fresh(
  id: string,
  overrides: Partial<FreshAttachmentDescriptor> = {},
): FreshAttachmentDescriptor {
  return { id, name: `${id}.png`, mime: "image/png", size: 100, ...overrides };
}

function retrySource(
  id: string,
  overrides: Partial<RetryAttachmentSource> = {},
): RetryAttachmentSource {
  return {
    id,
    storageKey: `chat/u1/${id}`,
    name: `${id}.png`,
    mime: "image/png",
    size: 100,
    degradedText: null,
    ...overrides,
  };
}

function insertRow(id: string, overrides: Partial<NewChatAttachment> = {}): NewChatAttachment {
  return {
    id,
    userId: "u1",
    messageId: "m1",
    storageKey: `chat/u1/${id}`,
    name: `${id}.png`,
    mime: "image/png",
    size: 100,
    position: 0,
    ...overrides,
  };
}

describe("freshAttachmentRowsMatchSubset", () => {
  test("an empty request matches any rows", () => {
    assert.equal(freshAttachmentRowsMatchSubset([], [summary("a")]), true);
  });

  test("matches when every declared field and the derived position agree", () => {
    assert.equal(
      freshAttachmentRowsMatchSubset(
        [fresh("a"), fresh("b")],
        [summary("a", { position: 0 }), summary("b", { position: 1 })],
      ),
      true,
    );
  });

  test("a missing row fails the match", () => {
    assert.equal(freshAttachmentRowsMatchSubset([fresh("a")], []), false);
  });

  for (const [field, changed] of [
    ["name", fresh("a", { name: "other.png" })],
    ["mime", fresh("a", { mime: "image/webp" })],
    ["size", fresh("a", { size: 101 })],
  ] as const) {
    test(`a changed ${field} fails the match`, () => {
      assert.equal(freshAttachmentRowsMatchSubset([changed], [summary("a")]), false);
    });
  }

  test("position defaults to the request index, not to the row's value", () => {
    assert.equal(
      freshAttachmentRowsMatchSubset(
        [fresh("a"), fresh("b")],
        [summary("a", { position: 0 }), summary("b", { position: 5 })],
      ),
      false,
    );
  });

  test("an explicit position overrides the index", () => {
    assert.equal(
      freshAttachmentRowsMatchSubset(
        [fresh("a", { position: 3 })],
        [summary("a", { position: 3 })],
      ),
      true,
    );
  });

  test("it is a SUBSET check: extra rows do not fail it", () => {
    assert.equal(
      freshAttachmentRowsMatchSubset([fresh("a")], [summary("a"), summary("b", { position: 1 })]),
      true,
    );
  });
});

describe("attachmentRequestMatchesExistingRows", () => {
  test("no attachments and no rows is a match", () => {
    assert.equal(
      attachmentRequestMatchesExistingRows({ fresh: [], retrySources: [], rows: [] }),
      true,
    );
  });

  test("a row count that differs from fresh + retry fails", () => {
    assert.equal(
      attachmentRequestMatchesExistingRows({
        fresh: [fresh("a")],
        retrySources: [],
        rows: [summary("a"), summary("b", { position: 1 })],
      }),
      false,
    );
  });

  test("retry rows are matched by ORDER after the fresh ones, not by id", () => {
    // The retry rows carry NEWLY minted ids (the bytes are copied under this
    // message's prefix), so only their position and metadata can be compared.
    assert.equal(
      attachmentRequestMatchesExistingRows({
        fresh: [fresh("a")],
        retrySources: [retrySource("src-1", { name: "one.png" })],
        rows: [summary("a", { position: 0 }), summary("copied", { name: "one.png", position: 1 })],
      }),
      true,
    );
  });

  test("a retry row at the wrong position fails", () => {
    assert.equal(
      attachmentRequestMatchesExistingRows({
        fresh: [fresh("a")],
        retrySources: [retrySource("src-1", { name: "one.png" })],
        rows: [summary("a", { position: 0 }), summary("copied", { name: "one.png", position: 2 })],
      }),
      false,
    );
  });

  test("a retry row with different metadata fails", () => {
    assert.equal(
      attachmentRequestMatchesExistingRows({
        fresh: [],
        retrySources: [retrySource("src-1", { size: 100 })],
        rows: [summary("copied", { name: "src-1.png", size: 999 })],
      }),
      false,
    );
  });

  test("a fresh attachment whose row is missing fails even at the right count", () => {
    assert.equal(
      attachmentRequestMatchesExistingRows({
        fresh: [fresh("a")],
        retrySources: [],
        rows: [summary("z")],
      }),
      false,
    );
  });
});

describe("sameInsertedAttachmentRows", () => {
  test("the rows just inserted match themselves", () => {
    const rows = [insertRow("a"), insertRow("b", { position: 1 })];
    assert.equal(
      sameInsertedAttachmentRows(rows, [
        summary("a", { position: 0 }),
        summary("b", { position: 1 }),
      ]),
      true,
    );
  });

  test("a differing count fails", () => {
    assert.equal(sameInsertedAttachmentRows([insertRow("a")], []), false);
  });

  test("a row the insert did not write fails", () => {
    assert.equal(sameInsertedAttachmentRows([insertRow("a")], [summary("z")]), false);
  });

  test("a changed size fails", () => {
    assert.equal(
      sameInsertedAttachmentRows([insertRow("a", { size: 100 })], [summary("a", { size: 200 })]),
      false,
    );
  });
});
