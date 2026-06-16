import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeSignificance } from "../../src/modules/memory/significance";
import {
  accumulateDoc,
  splitAddressList,
  type ContactAggregate,
} from "../../src/modules/memory/team-graph";

const NOW = new Date("2026-06-16T12:00:00.000Z");
// Person classification needs a display name with a space OR a separator in the
// local part (sender-context.ts), so the fixtures use realistic person headers.
const SELF = "me.user@acme.com";

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

describe("accumulateDoc", () => {
  const t1 = new Date("2026-06-10T00:00:00.000Z");
  const t2 = new Date("2026-06-14T00:00:00.000Z");

  test("a received message counts the sender inbound and others co-recipient; self is skipped", () => {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(
      c,
      {
        from: "Alice Smith <alice.smith@acme.com>",
        to: "me.user@acme.com, Bob Jones <bob.jones@acme.com>",
        isSent: false,
      },
      t1,
      SELF,
    );
    assert.equal(c.get(SELF), undefined); // self never becomes a contact
    assert.equal(c.get("alice.smith@acme.com")?.inbound, 1);
    assert.equal(c.get("bob.jones@acme.com")?.coRecipient, 1);
  });

  test("a sent message counts every recipient outbound", () => {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(
      c,
      {
        from: "me.user@acme.com",
        to: "Alice Smith <alice.smith@acme.com>, Bob Jones <bob.jones@acme.com>",
        isSent: true,
      },
      t1,
      SELF,
    );
    assert.equal(c.get("alice.smith@acme.com")?.outbound, 1);
    assert.equal(c.get("bob.jones@acme.com")?.outbound, 1);
  });

  test("accumulating two docs sums counts and tracks first/last seen", () => {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(c, { from: "Alice Smith <alice.smith@acme.com>", isSent: false }, t1, SELF);
    accumulateDoc(
      c,
      { from: "me.user@acme.com", to: "Alice Smith <alice.smith@acme.com>", isSent: true },
      t2,
      SELF,
    );
    const alice = c.get("alice.smith@acme.com");
    assert.equal(alice?.inbound, 1);
    assert.equal(alice?.outbound, 1); // two-way → real relationship shape
    assert.equal(alice?.firstSeenAt?.toISOString(), t1.toISOString());
    assert.equal(alice?.lastSeenAt?.toISOString(), t2.toISOString());
  });

  test("a noreply/service envelope is not captured as a person", () => {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(c, { from: "noreply@github.com", isSent: false }, t1, SELF);
    accumulateDoc(c, { from: "notifications@slack.com", isSent: false }, t1, SELF);
    assert.equal(c.size, 0);
  });

  test("a real human on a known-service domain IS captured (the rescue)", () => {
    // Triage classifies whole service domains (google.com, github.com, …) as
    // `service`; a real colleague at one of them must still become a contact.
    const c = new Map<string, ContactAggregate>();
    // first.last local part on a service domain
    accumulateDoc(c, { from: "jane.doe@google.com", isSent: false }, t1, SELF);
    // person-like display name with a single-token local on a service domain
    accumulateDoc(c, { from: "Karthik Rao <karthik@github.com>", isSent: false }, t1, SELF);
    assert.equal(c.get("jane.doe@google.com")?.inbound, 1);
    assert.equal(c.get("karthik@github.com")?.inbound, 1);
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
