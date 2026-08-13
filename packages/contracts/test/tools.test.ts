import assert from "node:assert/strict";
import test from "node:test";
import { hashToolInput } from "@alfred/contracts";

test("hashToolInput canonicalizes own enumerable object properties", () => {
  class Box {
    value = 1;
  }

  assert.equal(
    hashToolInput("gmail.search", new Box()),
    hashToolInput("gmail.search", { value: 1 }),
  );
});
