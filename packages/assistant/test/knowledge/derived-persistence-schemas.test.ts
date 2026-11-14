import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { proposeFactArgsSchema } from "../../src/knowledge/facts";

describe("derived memory persistence schemas", () => {
  test("proposeFact derives insert optionality and preserves boundary transforms", () => {
    const parsed = proposeFactArgsSchema.parse({
      userId: "usr_1",
      key: "company",
      value: "Acme",
      confidence: 1.2,
      source: { kind: "document", id: "doc_1" },
    });

    assert.equal(parsed.confidence, 1);
    assert.equal("validFrom" in parsed, false);
    assert.equal("validUntil" in parsed, false);
    assert.equal(
      proposeFactArgsSchema.safeParse({
        userId: "usr_1",
        key: "company",
        value: "Acme",
        confidence: 0.8,
        source: { kind: "invented" },
      }).success,
      false,
    );
  });
});
