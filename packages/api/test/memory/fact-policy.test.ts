import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  authoredByUser,
  classifyDocumentFactKey,
  gateDocumentFact,
  isSingleValuedKey,
  SINGLE_VALUED_KEYS,
  validateFactValueForKey,
  type AuthorshipDocument,
  type SelfIdentity,
} from "../../src/modules/memory/fact-policy";

describe("classifyDocumentFactKey (#330 — document write tiers)", () => {
  test("relationship:<email> is Tier A (authorship-free)", () => {
    assert.equal(classifyDocumentFactKey("relationship:alice@oliv.ai"), "tierA");
  });

  test("canonical identity/profile keys are Tier B (authorship-required)", () => {
    for (const key of [
      "employer",
      "job_title",
      "home_city",
      "home_country",
      "github_username",
      "personal_site",
      "full_name",
      "timezone",
    ]) {
      assert.equal(classifyDocumentFactKey(key), "tierB", `${key} should be tierB`);
    }
  });

  test("pref:*, standing_instruction, phone_number, and junk are not_writable", () => {
    for (const key of [
      "pref:tone",
      "standing_instruction",
      "phone_number",
      "evoting_url",
      "programming_language",
      "starbucks_stars",
      "zoom_meeting_passcode",
    ]) {
      assert.equal(classifyDocumentFactKey(key), "not_writable", `${key} should be not_writable`);
    }
  });
});

describe("validateFactValueForKey", () => {
  test("identity keys require a non-empty string", () => {
    assert.deepEqual(validateFactValueForKey("employer", "Oliv AI"), { ok: true });
    assert.deepEqual(validateFactValueForKey("employer", ""), {
      ok: false,
      reason: "expected_string_value",
    });
    assert.deepEqual(validateFactValueForKey("employer", 42), {
      ok: false,
      reason: "expected_string_value",
    });
  });

  test("relationship accepts a role string or any object (incl empty — the edge is the signal)", () => {
    assert.deepEqual(validateFactValueForKey("relationship:a@x.com", "mentor"), { ok: true });
    assert.deepEqual(validateFactValueForKey("relationship:a@x.com", { role: "friend" }), {
      ok: true,
    });
    // An empty object is a known correspondent whose role wasn't captured — KEEP it.
    assert.deepEqual(validateFactValueForKey("relationship:a@x.com", {}), { ok: true });
    // Only clearly-wrong primitives are rejected.
    for (const bad of [42, true, null, "", ["x"]]) {
      assert.deepEqual(validateFactValueForKey("relationship:a@x.com", bad), {
        ok: false,
        reason: "invalid_relationship_value",
      });
    }
  });

  test("pref:* is freeform", () => {
    assert.deepEqual(validateFactValueForKey("pref:tone", { warmth: 3 }), { ok: true });
  });
});

describe("SINGLE_VALUED_KEYS", () => {
  test("covers the canonical profile spine but not relationship/pref/phone", () => {
    assert.equal(isSingleValuedKey("employer"), true);
    assert.equal(isSingleValuedKey("home_city"), true);
    assert.equal(isSingleValuedKey("relationship:a@x.com"), false);
    assert.equal(isSingleValuedKey("pref:tone"), false);
    assert.equal(isSingleValuedKey("phone_number"), false);
    // notable_relations / family_summary are open-ended paragraphs — multi-valued.
    assert.equal(isSingleValuedKey("notable_relations"), false);
    assert.ok(SINGLE_VALUED_KEYS.length > 0);
  });
});

describe("authoredByUser (#330 — conservative, evidence-returning)", () => {
  const self: SelfIdentity = {
    emails: ["yash@oliv.ai"],
    gmailAccountEmailById: { acc_work: "yash@oliv.ai", acc_personal: "yash@gmail.com" },
    github: { login: "99Yash", userId: "583231" },
    slack: { userId: "U07SELF", emails: ["yash@oliv.ai"] },
  };

  function gmailDoc(
    metadata: Record<string, unknown>,
    accountId: string | null,
  ): AuthorshipDocument {
    return { source: "gmail", metadata, accountId };
  }

  test("gmail SENT label is authorship by the connected mailbox", () => {
    const r = authoredByUser(gmailDoc({ isSent: true }, "acc_work"), self);
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.source, "gmail");
    assert.equal(r.authoredByUser && r.proof.method, "sent_flag");
  });

  test("gmail raw SENT label is authorship for legacy rows without metadata.isSent", () => {
    const r = authoredByUser(gmailDoc({ labelIds: ["INBOX", "SENT"] }, "acc_work"), self);
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "sent_flag");
  });

  test("gmail From == connected-account email is authorship", () => {
    const r = authoredByUser(gmailDoc({ from: "Yash <yash@gmail.com>" }, "acc_personal"), self);
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "from_connected_account");
  });

  test("gmail inbound From from a third party fails attribution (the bug)", () => {
    // A contact's signature-block email — the city-leak failure mode.
    const r = authoredByUser(gmailDoc({ from: "Sandro <sandro@maglione.dev>" }, "acc_work"), self);
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "identity_mismatch");
  });

  test("gmail with no From and no SENT flag is missing_author_identity", () => {
    const r = authoredByUser(gmailDoc({ snippet: "hi" }, "acc_work"), self);
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "missing_author_identity");
  });

  test("github author id/login matches self", () => {
    const byId = authoredByUser(
      { source: "github", metadata: { authorId: "583231" }, accountId: null },
      self,
    );
    assert.equal(byId.authoredByUser, true);
    assert.equal(byId.authoredByUser && byId.proof.method, "author_id");

    const byLogin = authoredByUser(
      { source: "github", metadata: { authorLogin: "99yash" }, accountId: null },
      self,
    );
    assert.equal(byLogin.authoredByUser, true);
    assert.equal(byLogin.authoredByUser && byLogin.proof.method, "author_login");

    const other = authoredByUser(
      { source: "github", metadata: { authorLogin: "mattpocock" }, accountId: null },
      self,
    );
    assert.equal(other.authoredByUser, false);
    assert.equal(!other.authoredByUser && other.reason, "identity_mismatch");
  });

  test("slack matches on stable user id or verified email", () => {
    const r = authoredByUser(
      { source: "slack", metadata: { authorUserId: "U07SELF" }, accountId: null },
      self,
    );
    assert.equal(r.authoredByUser, true);
    assert.equal(r.authoredByUser && r.proof.method, "author_user_id");
  });

  test("github with no self identity fails missing_self_identity (default deny)", () => {
    const r = authoredByUser(
      { source: "github", metadata: { authorLogin: "anyone" }, accountId: null },
      { emails: ["yash@oliv.ai"] },
    );
    assert.equal(r.authoredByUser, false);
    assert.equal(!r.authoredByUser && r.reason, "missing_self_identity");
  });

  test("gcal / notion / imessage / uploads / unknown are unsupported_source", () => {
    for (const source of ["gcal", "google_calendar", "notion", "imessage", "upload", "weird"]) {
      const r = authoredByUser({ source, metadata: {}, accountId: null }, self);
      assert.equal(r.authoredByUser, false, `${source} should not be authored`);
      assert.equal(!r.authoredByUser && r.reason, "unsupported_source");
    }
  });
});

describe("gateDocumentFact", () => {
  const self: SelfIdentity = {
    emails: ["yash@oliv.ai"],
    gmailAccountEmailById: { acc_work: "yash@oliv.ai" },
  };
  const authoredDoc: AuthorshipDocument = {
    source: "gmail",
    metadata: { isSent: true },
    accountId: "acc_work",
  };

  test("rejects invalid Tier-B value shapes at the workflow/purge gate", () => {
    const r = gateDocumentFact({
      proposal: { key: "employer", value: 42 },
      document: authoredDoc,
      selfIdentity: self,
    });

    assert.deepEqual(r, {
      ok: false,
      reason: "invalid_value",
      originalKey: "employer",
      canonicalKey: "employer",
    });
  });
});
