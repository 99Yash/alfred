import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  NON_HUMAN_RELATIONSHIP,
  RELATIONSHIP_READ_FAILED,
  isColdContactFromSignals,
  type SenderSignificanceBucket,
} from "@alfred/assistant/triage/sender-relationship";

// ---------------------------------------------------------------------------
// isColdContactFromSignals (rule 16b). Consumers inject `isColdContact`, so only
// this table tests the derivation.
// ---------------------------------------------------------------------------

describe("isColdContactFromSignals", () => {
  const cases: Array<{
    label: string;
    inbound: number;
    outbound: number;
    bucket: SenderSignificanceBucket;
    cold: boolean;
  }> = [
    // The user never replied: cold at any score.
    { label: "one-way inbound, unscored", inbound: 3, outbound: 0, bucket: "unscored", cold: true },
    { label: "one-way inbound, weak", inbound: 3, outbound: 0, bucket: "weak", cold: true },
    { label: "one-way inbound, strong", inbound: 3, outbound: 0, bucket: "strong", cold: true },
    // Two-way is never cold, even when the score is `weak`.
    { label: "two-way, unscored", inbound: 4, outbound: 2, bucket: "unscored", cold: false },
    { label: "two-way, weak", inbound: 4, outbound: 2, bucket: "weak", cold: false },
    { label: "two-way, moderate", inbound: 4, outbound: 2, bucket: "moderate", cold: false },
    { label: "two-way, strong", inbound: 4, outbound: 2, bucket: "strong", cold: false },
    // Outbound only: cold only when the score is `weak`.
    {
      label: "one-way outbound, unscored",
      inbound: 0,
      outbound: 2,
      bucket: "unscored",
      cold: false,
    },
    {
      label: "one-way outbound, moderate",
      inbound: 0,
      outbound: 2,
      bucket: "moderate",
      cold: false,
    },
    { label: "one-way outbound, strong", inbound: 0, outbound: 2, bucket: "strong", cold: false },
    { label: "one-way outbound, weak", inbound: 0, outbound: 2, bucket: "weak", cold: true },
    // Matches the `NO_PRIOR_CONTACT` default that the resolver returns first.
    { label: "no correspondence", inbound: 0, outbound: 0, bucket: "unscored", cold: true },
  ];

  for (const c of cases) {
    test(`${c.label} → ${c.cold ? "cold" : "not cold"}`, () => {
      assert.equal(
        isColdContactFromSignals({ inbound: c.inbound, outbound: c.outbound, bucket: c.bucket }),
        c.cold,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Degrade constants. A failed read is not cold, so a DB blip cannot drop a real todo.
// A successful read with no history is cold (`NO_PRIOR_CONTACT`).
// ---------------------------------------------------------------------------

describe("relationship degrade constants", () => {
  test("read-failed keeps the todo (isColdContact false, no descriptor)", () => {
    assert.deepEqual(RELATIONSHIP_READ_FAILED, { descriptor: null, isColdContact: false });
  });

  test("non-human sender carries no person-waiting stake (isColdContact false)", () => {
    assert.deepEqual(NON_HUMAN_RELATIONSHIP, { descriptor: null, isColdContact: false });
  });
});
