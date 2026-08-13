import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DOCUMENT_SOURCES, documentSourceSchema, type DocumentSource } from "@alfred/contracts";
import type { Document } from "@alfred/db/schemas";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const documentRowUsesContract = true satisfies Equal<Document["source"], DocumentSource>;

describe("documentSourceSchema", () => {
  test("accepts every canonical document source", () => {
    assert.equal(documentRowUsesContract, true);
    for (const source of DOCUMENT_SOURCES) {
      assert.equal(documentSourceSchema.parse(source), source);
    }
  });

  test("rejects a source outside the canonical set", () => {
    assert.equal(documentSourceSchema.safeParse("smoke").success, false);
  });
});
