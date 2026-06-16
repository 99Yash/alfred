import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeSignificance } from "../../src/modules/memory/significance";
import { splitAddressList } from "../../src/modules/memory/team-graph";

const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("splitAddressList", () => {
  test("splits a plain comma-separated list", () => {
    assert.deepEqual(splitAddressList("a@x.com, b@y.com,c@z.com"), [
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  test("does not split on a comma inside a quoted display name", () => {
    assert.deepEqual(splitAddressList('"Doe, Jane" <jane@x.com>, bob@y.com'), [
      '"Doe, Jane" <jane@x.com>',
      "bob@y.com",
    ]);
  });

  test("does not split on a comma inside angle brackets", () => {
    // pathological but real: some clients emit group syntax
    assert.deepEqual(splitAddressList("Team <team@x.com>, Ann <ann@y.com>"), [
      "Team <team@x.com>",
      "Ann <ann@y.com>",
    ]);
  });

  test("empty / null → []", () => {
    assert.deepEqual(splitAddressList(null), []);
    assert.deepEqual(splitAddressList("   "), []);
  });
});

describe("computeSignificance", () => {
  test("a two-way recent same-org contact scores high", () => {
    const sig = computeSignificance({
      stats: {
        inbound: 30,
        outbound: 25,
        coRecipient: 10,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-06-15T00:00:00.000Z",
      },
      sameOrg: true,
      now: NOW,
    });
    assert.equal(sig.components.reciprocity, 1);
    assert.equal(sig.components.sameOrg, 1);
    assert.ok(sig.score > 0.75, `expected high score, got ${sig.score}`);
  });

  test("a cold one-way sender (the ADR-0059 shape) scores low", () => {
    const sig = computeSignificance({
      stats: {
        inbound: 1,
        outbound: 0,
        coRecipient: 0,
        firstSeenAt: "2026-06-13T00:00:00.000Z",
        lastSeenAt: "2026-06-13T00:00:00.000Z",
      },
      sameOrg: false,
      now: NOW,
    });
    // never replied → reciprocity floor; off-domain; tiny volume
    assert.equal(sig.components.reciprocity, 0.2);
    assert.equal(sig.components.sameOrg, 0);
    assert.ok(sig.score < 0.35, `expected low score, got ${sig.score}`);
  });

  test("a warm contact decays as last-seen recedes", () => {
    const base = {
      inbound: 10,
      outbound: 8,
      coRecipient: 0,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const recent = computeSignificance({
      stats: { ...base, lastSeenAt: "2026-06-15T00:00:00.000Z" },
      sameOrg: false,
      now: NOW,
    });
    const stale = computeSignificance({
      stats: { ...base, lastSeenAt: "2025-06-15T00:00:00.000Z" },
      sameOrg: false,
      now: NOW,
    });
    assert.ok(
      recent.score > stale.score,
      `recent ${recent.score} should beat stale ${stale.score}`,
    );
  });

  test("score stays within [0,1] under all-max inputs", () => {
    const sig = computeSignificance({
      stats: {
        inbound: 10_000,
        outbound: 10_000,
        coRecipient: 10_000,
        firstSeenAt: NOW.toISOString(),
        lastSeenAt: NOW.toISOString(),
      },
      sameOrg: true,
      now: NOW,
    });
    assert.ok(sig.score >= 0 && sig.score <= 1, `score out of range: ${sig.score}`);
  });
});
