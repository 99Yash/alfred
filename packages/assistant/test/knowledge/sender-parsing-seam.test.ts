import assert from "node:assert/strict";
import { describe, test } from "node:test";

// Internal helpers, not in the `knowledge` barrel.
import {
  authoredByUser,
  type AuthorshipDocument,
  type SelfIdentity,
} from "@alfred/assistant/knowledge/fact-policy";
import { accumulateDoc, type ContactAggregate } from "@alfred/assistant/knowledge/team-graph";
import { gmailSenderAdapter } from "@alfred/assistant/triage/gmail-sender-adapter";

/**
 * Pins sender parsing as seen through memory's seams (`authoredByUser`, `accumulateDoc`).
 * The parse lives in `triage/gmail-sender-adapter.ts` (ADR-0089).
 * Characterization: quirks are pinned on purpose, so a cleanup cannot change them silently.
 */

const self: SelfIdentity = {
  emails: ["yash@gmail.com", "yash@oliv.ai"],
  gmailAccountEmailById: { acc_work: "yash@oliv.ai", acc_personal: "yash@gmail.com" },
};

function gmailDoc(
  metadata: Record<string, unknown> | null,
  accountId: string | null,
): AuthorshipDocument {
  // Parse with the production adapter, as the seam does.
  return {
    source: "gmail",
    metadata,
    accountId,
    sender: gmailSenderAdapter.authorship(metadata),
  } as AuthorshipDocument;
}

describe("[campaign-04 seam] authoredByGmail — SENT-flag authorship via isSentGmailMetadata", () => {
  test("metadata.isSent === true is authorship by the connected mailbox (sent_flag)", () => {
    const r = authoredByUser(gmailDoc({ isSent: true }, "acc_work"), self);
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "sent_flag");
  });

  test("a raw SENT labelId (no isSent flag) is also authorship — the OR signal", () => {
    const r = authoredByUser(gmailDoc({ labelIds: ["INBOX", "SENT"] }, "acc_work"), self);
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "sent_flag");
  });

  test("SENT flag short-circuits BEFORE the From/account check — a third-party From still passes", () => {
    // SENT wins over From: a sent doc is the user's even with a foreign From.
    const r = authoredByUser(
      gmailDoc({ isSent: true, from: "Sandro <sandro@maglione.dev>" }, "acc_work"),
      self,
    );

    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "sent_flag");
  });

  test("QUIRK: the SENT labelId match is case-sensitive — 'Sent'/'sent' do NOT count", () => {
    // Quirk: the label match is exact, so "Sent" is not a sent signal.
    for (const label of ["Sent", "sent", "Sent Mail"]) {
      const r = authoredByUser(gmailDoc({ labelIds: [label] }, "acc_work"), self);
      assert.equal(r.authoredByUser, false, `labelIds ["${label}"] must not be sent`);
      assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
    }
  });

  test("QUIRK: isSent is matched with strict === true — truthy non-true values do NOT count", () => {
    // Quirk: only boolean `true` is a sent signal.
    for (const isSent of [1, "true", "SENT", {}] as const) {
      const r = authoredByUser(gmailDoc({ isSent }, "acc_work"), self);
      assert.equal(r.authoredByUser, false, `isSent=${JSON.stringify(isSent)} must not be sent`);
      assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
    }
  });

  test("QUIRK: null metadata is treated as not-sent (and, with no From, missing_author_identity)", () => {
    const r = authoredByUser(gmailDoc(null, "acc_work"), self);
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
  });
});

describe("[campaign-04 seam] authoredByGmail — From-header normalization via extractSenderContext", () => {
  test("normalizes an angle-bracketed, mixed-case From to lowercase local@domain", () => {
    // "Yash Gouravkar <YASH@Gmail.com>" → "yash@gmail.com", matching acc_personal.
    const r = authoredByUser(
      gmailDoc({ from: "Yash Gouravkar <YASH@Gmail.com>" }, "acc_personal"),
      self,
    );

    assert.equal(r.authoredByUser, true);
    assert.equal(
      r.authoredByUser && r.proof.source === "gmail" && r.proof.fromEmail,
      "yash@gmail.com",
    );
  });

  test("normalizes a bare (no angle brackets), upper-case From the same way", () => {
    const r = authoredByUser(gmailDoc({ from: "YASH@GMAIL.COM" }, "acc_personal"), self);
    assert.equal(r.authoredByUser, true);
    assert.equal(
      r.authoredByUser && r.proof.source === "gmail" && r.proof.fromEmail,
      "yash@gmail.com",
    );
  });

  test("QUIRK: a Gmail +tag is NOT stripped — 'yash+work@gmail.com' ≠ self 'yash@gmail.com'", () => {
    // Keeps the +tag, unlike canonicalizeEmailForMatch. Stripping it would make this the user's mail.
    const r = authoredByUser(gmailDoc({ from: "Yash+Work@GMAIL.com" }, null), self);
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "identity_mismatch");
    assert.equal(
      !r.authoredByUser && r.observed?.kind === "email" && r.observed.value,
      "yash+work@gmail.com",
    );
  });

  test("QUIRK: an unparseable From yields a null address → missing_author_identity", () => {
    const r = authoredByUser(gmailDoc({ from: "hello there" }, "acc_work"), self);
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
  });

  test("QUIRK: a dot-less domain (e.g. 'user@localhost') is unparseable → missing_author_identity", () => {
    const r = authoredByUser(gmailDoc({ from: "user@localhost" }, "acc_work"), self);
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
  });
});

describe("[campaign-04 seam] accumulateDoc — team-graph human rescue via isHumanLikeSender", () => {
  const t1 = new Date("2026-06-10T00:00:00.000Z");
  const SELF = "me.user@acme.com";

  function keysFor(meta: Record<string, unknown>): string[] {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(c, gmailSenderAdapter.correspondents(meta), t1, SELF);

    return [...c.keys()];
  }

  test("rescues a first.last local part on a service domain (google.com)", () => {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(
      c,
      gmailSenderAdapter.correspondents({ from: "jane.doe@google.com", isSent: false }),
      t1,
      SELF,
    );
    assert.equal(c.get("jane.doe@google.com")?.inbound, 1);
  });

  test("rescues a single-token local on a service domain when the display name looks human", () => {
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(
      c,
      gmailSenderAdapter.correspondents({
        from: "Karthik Rao <karthik@github.com>",
        isSent: false,
      }),
      t1,
      SELF,
    );
    assert.equal(c.get("karthik@github.com")?.inbound, 1);
  });

  test("does NOT rescue a bare single-token local on a service domain (no human signal)", () => {
    // A service-domain sender with no human signal is dropped.
    assert.deepEqual(keysFor({ from: "karthik@github.com", isSent: false }), []);
  });

  test("QUIRK: an automated-envelope local part is never rescued, even behind a human display name", () => {
    // A person-like display name cannot rescue a noreply@ local part.
    assert.deepEqual(keysFor({ from: "John Smith <noreply@acme.com>", isSent: false }), []);
  });

  test("a plain no-reply / notifications envelope is dropped", () => {
    assert.deepEqual(keysFor({ from: "notifications@slack.com", isSent: false }), []);
  });

  test("an unparseable From token is dropped (no contact minted)", () => {
    assert.deepEqual(keysFor({ from: "hello there", isSent: false }), []);
  });

  test("QUIRK: team-graph's own isSent is `meta.isSent === true` — a SENT labelId does NOT flip direction", () => {
    // Unlike fact-policy, the team graph ignores labelIds, so a SENT label alone stays inbound.
    const c = new Map<string, ContactAggregate>();
    accumulateDoc(
      c,
      gmailSenderAdapter.correspondents({
        from: "Alice Smith <alice.smith@acme.com>",
        labelIds: ["SENT"],
      }),
      t1,
      SELF,
    );
    assert.equal(c.get("alice.smith@acme.com")?.inbound, 1);
    assert.equal(c.get("alice.smith@acme.com")?.outbound, 0);
  });
});
