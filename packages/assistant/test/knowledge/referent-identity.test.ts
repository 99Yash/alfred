import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gmailEmailMessagePayloadSchema, identityValueMatchesKind } from "@alfred/contracts";
import {
  globalReferentIdentity,
  referentKeyForEmail,
  senderScopedReferentIdentity,
  REFERENT_IDENTITY_KIND,
  type GlobalReferentKey,
  type ReferentKey,
  type SenderScopedReferentKey,
} from "@alfred/assistant/knowledge";

const GITHUB_SENDER = "notifications@github.com";
const SNS_SENDER = "no-reply@sns.amazonaws.com";

function globalKey(key: ReferentKey | null): GlobalReferentKey {
  assert.ok(key, "expected a referent key");
  assert.equal(key.scope, "global");
  return key;
}

function senderKey(key: ReferentKey | null): SenderScopedReferentKey {
  assert.ok(key, "expected a referent key");
  assert.equal(key.scope, "sender");
  return key;
}

describe("referentKeyForEmail — GitHub threading headers", () => {
  // Header shapes copied verbatim from real `email_message` observations.
  test("a review email and a comment email on one PR yield one key", () => {
    const review = globalKey(
      referentKeyForEmail({
        subject: "Re: [99Yash/alfred] fix(onboarding): polish flow (PR #913)",
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/pull/913/review/5048198919@github.com>",
          inReplyTo: "<99Yash/alfred/pull/913@github.com>",
        },
      }),
    );
    const comment = globalKey(
      referentKeyForEmail({
        subject: "Re: [99Yash/alfred] fix(onboarding): polish flow (PR #913)",
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/pull/913/c5448868491@github.com>",
          inReplyTo: "<99Yash/alfred/pull/913@github.com>",
        },
      }),
    );
    assert.equal(review.value, "github:pull_request:99yash/alfred#913");
    assert.equal(comment.value, review.value);
    assert.equal(review.evidence, "github_threading_header");
  });

  test("the header key survives a subject the loop-key grammar cannot read", () => {
    // No `[owner/repo]` bracket and no `(PR #N)` — the subject grammar returns
    // nothing here, which is exactly why the header is the stronger evidence.
    const key = globalKey(
      referentKeyForEmail({
        subject: "Re: fix(onboarding): polish flow",
        sender: GITHUB_SENDER,
        headers: {
          inReplyTo: "<99Yash/alfred/pull/913@github.com>",
        },
      }),
    );
    assert.equal(key.value, "github:pull_request:99yash/alfred#913");
  });

  test("owner/repo case folds so one PR does not split into two nodes", () => {
    const upper = globalKey(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/Alfred/pull/913@github.com>",
        },
      }),
    );
    const lower = globalKey(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99yash/alfred/pull/913@github.com>",
        },
      }),
    );
    assert.equal(upper.value, lower.value);
  });

  test("issues, discussions and commits get their own object kinds", () => {
    assert.equal(
      globalKey(
        referentKeyForEmail({
          subject: null,
          sender: GITHUB_SENDER,
          headers: {
            messageId: "<99Yash/alfred/issues/353@github.com>",
          },
        }),
      ).value,
      "github:issue:99yash/alfred#353",
    );
    assert.equal(
      globalKey(
        referentKeyForEmail({
          subject: null,
          sender: GITHUB_SENDER,
          headers: {
            messageId: "<99Yash/alfred/discussions/7@github.com>",
          },
        }),
      ).value,
      "github:discussion:99yash/alfred#7",
    );
    assert.equal(
      globalKey(
        referentKeyForEmail({
          subject: null,
          sender: GITHUB_SENDER,
          headers: {
            messageId: "<99Yash/alfred/commit/F817B90ABCDEF@github.com>",
          },
        }),
      ).value,
      "github:commit:99yash/alfred@f817b90abcdef",
    );
  });

  test("a check-suite id keeps its case, because it is opaque and case-significant", () => {
    const key = globalKey(
      referentKeyForEmail({
        subject: "[99Yash/alfred] PR run failed: ci - fix(onboarding): polish flow",
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/check-suites/CS_kwDOSNoYNM8AAAAU6cdJog/1787896030@github.com>",
        },
      }),
    );
    assert.equal(key.value, "github:check_suite:99yash/alfred/CS_kwDOSNoYNM8AAAAU6cdJog");
  });

  test("references are read when In-Reply-To is absent", () => {
    const key = globalKey(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          references: ["<99Yash/alfred/pull/786@github.com>"],
          messageId: "<somethingelse@mail.example>",
        },
      }),
    );
    assert.equal(key.value, "github:pull_request:99yash/alfred#786");
  });

  test("a header from a non-GitHub sender mints nothing, so nobody can claim a PR node", () => {
    // The header is written by whoever sent the mail. Ungated, this message
    // would take the permanent node for 99Yash/alfred#913. The header class is
    // the STRONGER class and runs first, so a gate on the subject class alone
    // would never run.
    assert.equal(
      referentKeyForEmail({
        subject: "hey look at this",
        sender: "attacker@evil.example",
        headers: {
          messageId: "<99Yash/alfred/pull/913@github.com>",
          inReplyTo: "<99Yash/alfred/pull/913@github.com>",
        },
      }),
      null,
    );
  });

  test("an over-long opaque header id mints nothing rather than an illegal identity", () => {
    // `integration_object_key` ends in `.+`, so an unbounded id passes the
    // FORMAT and would fail only at the size refine much later.
    assert.equal(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: `<99Yash/alfred/check-suites/${"C".repeat(600)}@github.com>`,
        },
      }),
      null,
    );
  });

  test("a non-GitHub host and an unrecognized object shape both fall through", () => {
    // A GitHub-shaped local part on another host must not mint a GitHub key,
    // even when the sender IS GitHub.
    assert.equal(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/pull/913@github.com.evil.example>",
        },
      }),
      null,
    );
    // `push` is not on the allow-list: an unrecognized shape falls through
    // rather than guessing, because a wrong mint is permanent.
    assert.equal(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/push/refs/heads/main/f817b90@github.com>",
        },
      }),
      null,
    );
    // A numbered object whose id is not a number.
    assert.equal(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/pull/latest@github.com>",
        },
      }),
      null,
    );
  });
});

describe("referentKeyForEmail — the observation payload seam", () => {
  // `GmailEmailMessagePayload` carries TWO fields named `messageId`: the Gmail
  // message id at the top level and the RFC threading id under `headers`. Only
  // the second is evidence about a referent.
  function gmailPayload(headerMessageId: string | null, gmailMessageId: string) {
    return gmailEmailMessagePayloadSchema.parse({
      provider: "gmail",
      documentId: "doc_1",
      messageId: gmailMessageId,
      threadId: "thread_1",
      accountId: "acct_1",
      isSent: false,
      subject: null,
      subjectHash: null,
      headers: {
        messageId: headerMessageId,
        inReplyTo: null,
        references: [],
        listId: null,
        listUnsubscribe: null,
        replyTo: null,
        deliveredTo: null,
        autoSubmitted: null,
        precedence: null,
      },
    });
  }

  test("the payload's headers pass whole and resolve the referent", () => {
    const payload = gmailPayload("<99Yash/alfred/pull/913@github.com>", "1993f0a1b2c3d4e5");
    const key = globalKey(
      referentKeyForEmail({
        subject: payload.subject,
        sender: GITHUB_SENDER,
        headers: payload.headers,
      }),
    );
    assert.equal(key.value, "github:pull_request:99yash/alfred#913");
  });

  test("the Gmail message id is never read as a threading header", () => {
    // A Gmail id shaped like a GitHub threading id must mint nothing. Reading
    // the wrong `messageId` here would silently disable the header class for
    // every real message, because a Gmail id never parses.
    const payload = gmailPayload(null, "99Yash/alfred/pull/913@github.com");
    assert.equal(
      referentKeyForEmail({
        subject: payload.subject,
        sender: GITHUB_SENDER,
        headers: payload.headers,
      }),
      null,
    );
  });
});

describe("referentKeyForEmail — subject grammar fallback", () => {
  test("a GitHub subject with no usable header still resolves to the same key shape", () => {
    const fromSubject = globalKey(
      referentKeyForEmail({
        subject: "Re: [99Yash/alfred] fix(onboarding): polish flow (PR #913)",
        sender: GITHUB_SENDER,
      }),
    );
    assert.equal(fromSubject.value, "github:pull_request:99yash/alfred#913");
    assert.equal(fromSubject.evidence, "loop_key_entity");
  });

  test("a Linear issue key resolves to a provider-global key", () => {
    const key = globalKey(
      referentKeyForEmail({
        subject: "ENG-123 blocked by a failing check",
        sender: "notifications@linear.app",
      }),
    );
    assert.equal(key.value, "linear:issue:eng-123");
  });

  test("a CloudWatch alarm is sender-scoped, and every recurrence shares the name", () => {
    const first = senderKey(
      referentKeyForEmail({
        subject: 'ALARM: "baserow-response-time" in US East (N. Virginia)',
        sender: SNS_SENDER,
      }),
    );
    const second = senderKey(
      referentKeyForEmail({
        subject: 'ALARM: "baserow-response-time" in US East (N. Virginia)',
        sender: SNS_SENDER,
      }),
    );
    assert.equal(first.name, "baserow-response-time");
    assert.equal(second.name, first.name);
  });

  test("a repeated vendor subject is sender-scoped even when the vendor is GitHub", () => {
    // Regression, found on the real corpus: reading the loop ref's PROVIDER
    // before its KIND promoted this normalized subject to a global
    // `github:subject:…` key, which would claim to identify an object across
    // every source. It identifies nothing outside this sender.
    const key = senderKey(
      referentKeyForEmail({
        subject: "[GitHub] Sudo email verification code",
        sender: "noreply@github.com",
      }),
    );
    assert.equal(key.name, "[github] sudo email verification code");
  });

  test("a human quoting a PR subject mints nothing, so unrelated rail items never merge", () => {
    assert.equal(
      referentKeyForEmail({
        subject: "Re: [99Yash/alfred] can you look at this (PR #913)",
        sender: "sanyam@oliv.ai",
      }),
      null,
    );
  });

  test("a plain human email is about a person, not an object", () => {
    assert.equal(
      referentKeyForEmail({ subject: "lunch tomorrow?", sender: "sanyam@oliv.ai" }),
      null,
    );
  });

  test("a runaway tracker subject mints nothing rather than an unbounded name", () => {
    // A subject this long never repeats, so it dedups nothing, and the value it
    // would build breaks `MAX_IDENTITY_VALUE_BYTES` far from the mint.
    assert.equal(
      referentKeyForEmail({
        subject: `Netsmart ${"save view issues ".repeat(60)}`,
        sender: "tasks@clickup.com",
      }),
      null,
    );
  });
});

describe("referent identity values", () => {
  test("a global identity is a legal integration_object_key", () => {
    const key = globalKey(
      referentKeyForEmail({
        subject: null,
        sender: GITHUB_SENDER,
        headers: {
          messageId: "<99Yash/alfred/pull/913@github.com>",
        },
      }),
    );
    const identity = globalReferentIdentity(key);
    assert.equal(identity.kind, REFERENT_IDENTITY_KIND);
    assert.ok(identityValueMatchesKind(identity.kind, identity.value));
  });

  test("a sender-scoped identity is legal and separates two senders using one name", () => {
    const key = senderKey(
      referentKeyForEmail({
        subject: 'ALARM: "baserow-response-time" in US East',
        sender: SNS_SENDER,
      }),
    );
    const fromSns = senderScopedReferentIdentity(key, "ent_aaaaaaaa");
    const fromHuman = senderScopedReferentIdentity(key, "ent_bbbbbbbb");
    assert.equal(fromSns.value, "alfred:referent:ent_aaaaaaaa/baserow-response-time");
    assert.notEqual(fromSns.value, fromHuman.value);
    assert.ok(identityValueMatchesKind(fromSns.kind, fromSns.value));
  });

  test("an identity value is checked against the whole contract, not just the format", () => {
    // `alfred:referent:<id>/<name>` matches `IDENTITY_VALUE_FORMATS` for any
    // non-empty tail, so a format-only assert would pass an oversized value and
    // let it fail at `computeStableEntityId` instead.
    const key = senderKey(
      referentKeyForEmail({
        subject: 'ALARM: "baserow-response-time" in US East',
        sender: SNS_SENDER,
      }),
    );
    assert.ok(
      identityValueMatchesKind(REFERENT_IDENTITY_KIND, `alfred:referent:${"x".repeat(4000)}/a`),
    );
    assert.throws(
      () => senderScopedReferentIdentity(key, "ent_".concat("a".repeat(4000))),
      /illegal integration_object_key value/,
    );
  });

  test("a sender-scoped identity refuses to mint without a sender node", () => {
    const key = senderKey(
      referentKeyForEmail({
        subject: 'ALARM: "baserow-response-time" in US East',
        sender: SNS_SENDER,
      }),
    );
    assert.throws(() => senderScopedReferentIdentity(key, "  "), /sender node id/);
  });
});
