import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  accumulateDoc,
  authoredByUser,
  type AuthorshipDocument,
  type ContactAggregate,
  type SelfIdentity,
} from "../../src/modules/knowledge";
import { gmailSenderAdapter } from "../../src/modules/triage/gmail-sender-adapter";

/**
 * Characterization pin for campaign knowledge-settings-phase4 item 04
 * ("Break `memory → triage`: email sender parsing out of knowledge").
 *
 * `memory` currently reaches into `triage` for three pieces of email-specific
 * parsing (the `memory ↔ triage` cycle this campaign removes):
 *
 *   - `fact-policy.ts` → `triage/sent-mail.isSentGmailMetadata` (Gmail SENT-flag
 *     authorship inside `authoredByGmail`),
 *   - `fact-policy.ts` → `triage/sender-context.extractSenderContext` (the
 *     `From:`-header → normalized `senderAddress` used by `authoredByGmail`),
 *   - `team-graph.ts` → `triage/sender-context.{extractSenderContext,
 *     isHumanLikeSender}` (the human-rescue that keeps a real person on a
 *     service domain in the team graph).
 *
 * These tests pin the OBSERVABLE outcome of that parsing through memory's own
 * public seams (`authoredByUser`, `accumulateDoc`) — the authorship verdict, the
 * normalized address, and team-graph inclusion/exclusion. Post-refactor
 * (ADR-0089) the parse lives in `triage/gmail-sender-adapter.ts`; these tests
 * now build the injected observation with `gmailSenderAdapter` from the SAME raw
 * metadata and feed it into memory's seams, so every verdict below stays
 * byte-identical to before the move. Characterization only: today's behavior,
 * quirks included. The quirks are called out so a "cleanup" during the move does
 * not silently change them.
 */

const self: SelfIdentity = {
  emails: ["yash@gmail.com", "yash@oliv.ai"],
  gmailAccountEmailById: { acc_work: "yash@oliv.ai", acc_personal: "yash@gmail.com" },
};

function gmailDoc(
  metadata: Record<string, unknown> | null,
  accountId: string | null,
): AuthorshipDocument {
  // Build the injected authorship observation from the SAME raw metadata the
  // triage adapter would parse in production — the whole point of the seam.
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
    // isSentGmailMetadata is consulted before any From parsing: a SENT-labelled
    // doc is the user's own even when From is a foreign address.
    const r = authoredByUser(
      gmailDoc({ isSent: true, from: "Sandro <sandro@maglione.dev>" }, "acc_work"),
      self,
    );
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "sent_flag");
  });

  test("QUIRK: the SENT labelId match is case-sensitive — 'Sent'/'sent' do NOT count", () => {
    // isSentGmailMetadata compares `label === "SENT"` exactly, so a differently
    // cased label is not a sent signal. With no From it falls through to the
    // missing-author verdict rather than authorship.
    for (const label of ["Sent", "sent", "Sent Mail"]) {
      const r = authoredByUser(gmailDoc({ labelIds: [label] }, "acc_work"), self);
      assert.equal(r.authoredByUser, false, `labelIds ["${label}"] must not be sent`);
      assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
    }
  });

  test("QUIRK: isSent is matched with strict === true — truthy non-true values do NOT count", () => {
    // Only the literal boolean true is a sent signal (`meta.isSent === true`),
    // so 1 / "true" are NOT sent and, absent a From, are missing_author_identity.
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
    // extractSenderContext lowercases but keeps the +tag (unlike
    // canonicalizeEmailForMatch, which strips it). A refactor that swaps in a
    // plus-stripping normalizer would wrongly attribute this to the user.
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

  // Feed accumulateDoc the observation the triage adapter parses from raw
  // metadata — the human-rescue now lives in the adapter, its outcome is pinned
  // here through the same seam.
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
    // "karthik@github.com" alone: service domain, no first.last, no person-like
    // display name → dropped. The rescue needs a positive human signal.
    assert.deepEqual(keysFor({ from: "karthik@github.com", isSent: false }), []);
  });

  test("QUIRK: an automated-envelope local part is never rescued, even behind a human display name", () => {
    // isHumanLikeSender rejects STRONG_SERVICE_LOCAL / service-prefix locals up
    // front, so a person-looking display name cannot rescue a noreply@ envelope.
    assert.deepEqual(keysFor({ from: "John Smith <noreply@acme.com>", isSent: false }), []);
  });

  test("a plain no-reply / notifications envelope is dropped", () => {
    assert.deepEqual(keysFor({ from: "notifications@slack.com", isSent: false }), []);
  });

  test("an unparseable From token is dropped (no contact minted)", () => {
    assert.deepEqual(keysFor({ from: "hello there", isSent: false }), []);
  });

  test("QUIRK: team-graph's own isSent is `meta.isSent === true` — a SENT labelId does NOT flip direction", () => {
    // Unlike fact-policy, accumulateDoc reads `meta.isSent === true` directly and
    // ignores labelIds. So a received-shaped doc carrying only a SENT label is
    // still treated as inbound: the From is counted as the correspondent, not
    // skipped as an outbound-from-self.
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
