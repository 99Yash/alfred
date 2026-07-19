import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  NON_HUMAN_RELATIONSHIP,
  RELATIONSHIP_READ_FAILED,
  isColdContactFromSignals,
  type SenderSignificanceBucket,
} from "../../src/modules/triage/sender-relationship";

// ---------------------------------------------------------------------------
// isColdContactFromSignals — the producer of the typed rule-16b cold-contact
// signal the todo gate branches on. Table-driven over the subtle branches so a
// regression that flips `outbound === 0` to `inbound === 0`, or drops the
// two-way guard, is caught here (the consumers inject `isColdContact` manually,
// so nothing else exercises this derivation).
// ---------------------------------------------------------------------------

describe("isColdContactFromSignals", () => {
  const cases: Array<{
    label: string;
    inbound: number;
    outbound: number;
    bucket: SenderSignificanceBucket;
    cold: boolean;
  }> = [
    // One-way inbound (the user never replied) → cold regardless of score.
    { label: "one-way inbound, unscored", inbound: 3, outbound: 0, bucket: "unscored", cold: true },
    { label: "one-way inbound, weak", inbound: 3, outbound: 0, bucket: "weak", cold: true },
    { label: "one-way inbound, strong", inbound: 3, outbound: 0, bucket: "strong", cold: true },
    // Two-way (the user sent at least one message back) → a real person waiting,
    // never cold — even unscored, and even when the score is `weak` (two-way
    // wins over weak).
    { label: "two-way, unscored", inbound: 4, outbound: 2, bucket: "unscored", cold: false },
    { label: "two-way, weak", inbound: 4, outbound: 2, bucket: "weak", cold: false },
    { label: "two-way, moderate", inbound: 4, outbound: 2, bucket: "moderate", cold: false },
    { label: "two-way, strong", inbound: 4, outbound: 2, bucket: "strong", cold: false },
    // One-way outbound ("you reached out, no reply yet") → cold ONLY when the
    // score is `weak`; an unscored/moderate/strong outreach is not cold.
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
    // No correspondence at all (the no-prior-contact shape) → cold. (The live
    // resolver short-circuits this via NO_PRIOR_CONTACT before reaching here, but
    // the derivation stays consistent with that default.)
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
// Degrade constants — a DB read failure must NOT feed the deterministic gate as
// cold (#517 D2): coldness is unknown, not confirmed absent, so a transient blip
// on a genuine two-way stakeholder cannot silently drop their real todo. This
// pins the "read-failed → keep" direction, distinct from the cold default a
// SUCCESSFUL no-history read takes (NO_PRIOR_CONTACT, isColdContact: true).
// ---------------------------------------------------------------------------

describe("relationship degrade constants", () => {
  test("read-failed keeps the todo (isColdContact false, no descriptor)", () => {
    assert.deepEqual(RELATIONSHIP_READ_FAILED, { descriptor: null, isColdContact: false });
  });

  test("non-human sender carries no person-waiting stake (isColdContact false)", () => {
    assert.deepEqual(NON_HUMAN_RELATIONSHIP, { descriptor: null, isColdContact: false });
  });
});
