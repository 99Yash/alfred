import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { proposeFactArgsSchema } from "../../src/modules/memory/facts";
import { upsertStyleProfileArgsSchema } from "../../src/modules/memory/style-profiles";

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

  test("style-profile upsert derives nullable/defaulted insert fields", () => {
    const parsed = upsertStyleProfileArgsSchema.parse({
      userId: "usr_1",
      channel: "gmail",
      audienceBucket: "peer",
      recipientId: null,
      profileDoc: "Write directly.",
    });

    assert.equal(parsed.recipientId, null);
    assert.equal("status" in parsed, false);
    assert.equal("generatedFromCount" in parsed, false);
  });

  test("style-profile JSON arrays reject values Postgres jsonb cannot store", () => {
    assert.equal(
      upsertStyleProfileArgsSchema.safeParse({
        userId: "usr_1",
        channel: "gmail",
        audienceBucket: "peer",
        profileDoc: "Write directly.",
        examples: [() => "not JSON"],
      }).success,
      false,
    );
  });
});
