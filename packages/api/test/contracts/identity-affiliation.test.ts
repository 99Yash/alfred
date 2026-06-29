import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  affiliationGroundingTier,
  canGroundIdentityKey,
  classifyEmailDomain,
  DOMAIN_CLASSES,
  domainClassSchema,
  FREE_MAIL_DOMAINS,
  GROUNDING_TIERS,
  GROUNDING_TIER_RANK,
  groundingTierRank,
  groundingTierSchema,
  isFreeMail,
  isObservationKindForSource,
  isProjectionIdentityKey,
  isStrongerGrounding,
  isUserFactKey,
  observationInsertSchema,
  PROJECTION_IDENTITY_KEYS,
  type DomainClass,
  type GroundingTier,
} from "@alfred/contracts";

/**
 * Pure unit tests for the ADR-0080 identity-affiliation deterministic core
 * (`docs/plans/identity-facts-projection-v1.md`). These are the safety floor the
 * design's invariant 3 ("deterministic core, LLM at the edges") rests on — the
 * domain classifier, the grounding-tier authority ranking, and the per-key
 * grounding rule. No DB, no LLM; they pin the exact behavior the projection
 * reducer will compose.
 */

describe("classifyEmailDomain — the four employer-signal outcomes (§4b)", () => {
  test("free-mail providers are consumer_email (no employer signal)", () => {
    for (const domain of ["gmail.com", "icloud.com", "proton.me", "outlook.com"]) {
      assert.equal(
        classifyEmailDomain({ email: `someone@${domain}` }),
        "consumer_email",
        domain,
      );
      assert.equal(classifyEmailDomain({ domain }), "consumer_email", domain);
    }
  });

  test("a real org domain is corporate_domain", () => {
    assert.equal(classifyEmailDomain({ email: "yash@oliv.ai" }), "corporate_domain");
    assert.equal(classifyEmailDomain({ email: "person@acme.com" }), "corporate_domain");
    assert.equal(classifyEmailDomain({ domain: "yourelasticdash.co" }), "corporate_domain");
  });

  test("role/service local parts are service_or_role_account regardless of domain", () => {
    // The Weekday-class failure mode is a recruiter, but the role-mailbox guard
    // covers the noreply/support sender family that must never read as employment.
    for (const email of [
      "noreply@acme.com",
      "no-reply@acme.com",
      "support@oliv.ai",
      "billing@stripe.com",
      "notifications@github.com",
      "support+ticket-123@acme.com",
    ]) {
      assert.equal(classifyEmailDomain({ email }), "service_or_role_account", email);
    }
  });

  test("a service/bounce host domain is service_or_role_account", () => {
    assert.equal(
      classifyEmailDomain({ email: "x@bounce.acme.com" }),
      "service_or_role_account",
    );
    assert.equal(classifyEmailDomain({ domain: "mailer.sendgrid.net" }), "service_or_role_account");
  });

  test("academic / alumni / shared-hosting / disposable are ambiguous_domain", () => {
    for (const domain of [
      "mit.edu",
      "cs.stanford.edu",
      "someone.ac.uk",
      "alumni.berkeley.edu",
      "alice.github.io",
      "myportfolio.wixsite.com",
      "mailinator.com",
    ]) {
      assert.equal(classifyEmailDomain({ domain }), "ambiguous_domain", domain);
    }
  });

  test("a real employer wins over the ambiguous-token substring trap", () => {
    // "alum" is an ambiguous token, but it must match as a domain hint, not a
    // bare substring of an unrelated org (`alumacorp.com`).
    assert.equal(classifyEmailDomain({ email: "ceo@alumacorp.com" }), "ambiguous_domain");
  });

  test("malformed / empty input returns null (no class, so no grounding)", () => {
    assert.equal(classifyEmailDomain({ email: "not-an-email" }), null);
    assert.equal(classifyEmailDomain({ email: "@no-local.com" }), null);
    assert.equal(classifyEmailDomain({ domain: "" }), null);
    assert.equal(classifyEmailDomain({}), null);
  });

  test("classification is case-insensitive and trims", () => {
    assert.equal(classifyEmailDomain({ email: "  Yash@OLIV.ai " }), "corporate_domain");
    assert.equal(classifyEmailDomain({ domain: "GMAIL.COM" }), "consumer_email");
  });

  test("every outcome is a valid DomainClass enum member", () => {
    const seen = new Set<DomainClass | null>([
      classifyEmailDomain({ email: "a@gmail.com" }),
      classifyEmailDomain({ email: "a@oliv.ai" }),
      classifyEmailDomain({ domain: "mit.edu" }),
      classifyEmailDomain({ email: "noreply@x.com" }),
    ]);
    for (const c of seen) {
      if (c !== null) assert.ok(domainClassSchema.safeParse(c).success, String(c));
    }
    assert.equal(DOMAIN_CLASSES.length, 4);
  });
});

describe("isFreeMail", () => {
  test("recognizes free-mail by domain or address", () => {
    assert.equal(isFreeMail("gmail.com"), true);
    assert.equal(isFreeMail("a@gmail.com"), true);
    assert.equal(isFreeMail("oliv.ai"), false);
    assert.equal(isFreeMail("a@oliv.ai"), false);
    assert.equal(isFreeMail(null), false);
    assert.equal(isFreeMail(undefined), false);
  });

  test("the canonical free-mail set carries the common providers", () => {
    for (const d of ["gmail.com", "icloud.com", "proton.me", "outlook.com", "yahoo.com"]) {
      assert.ok(FREE_MAIL_DOMAINS.has(d), d);
    }
  });
});

describe("grounding-tier authority ranking (§5)", () => {
  test("order is the rank, strongest first, no gaps", () => {
    assert.deepEqual(GROUNDING_TIERS[0], "user_correction");
    assert.deepEqual(GROUNDING_TIERS[GROUNDING_TIERS.length - 1], "weak_mentions");
    GROUNDING_TIERS.forEach((tier, i) => assert.equal(groundingTierRank(tier), i));
    assert.equal(Object.keys(GROUNDING_TIER_RANK).length, GROUNDING_TIERS.length);
  });

  test("user correction > profile edit > directory > corporate > self-authored > public > weak", () => {
    const expected: GroundingTier[] = [
      "user_correction",
      "user_profile_edit",
      "directory_verified",
      "corporate_affiliation",
      "self_authored_profile_or_signature",
      "corroborated_public_or_cold_start",
      "weak_mentions",
    ];
    assert.deepEqual([...GROUNDING_TIERS], expected);
  });

  test("isStrongerGrounding follows the order", () => {
    assert.equal(isStrongerGrounding("user_correction", "corporate_affiliation"), true);
    assert.equal(isStrongerGrounding("directory_verified", "corporate_affiliation"), true);
    assert.equal(isStrongerGrounding("corporate_affiliation", "directory_verified"), false);
    assert.equal(isStrongerGrounding("weak_mentions", "user_correction"), false);
    // a tier is never strictly stronger than itself
    assert.equal(isStrongerGrounding("corporate_affiliation", "corporate_affiliation"), false);
  });

  test("every tier is a valid enum member", () => {
    for (const t of GROUNDING_TIERS) {
      assert.ok(groundingTierSchema.safeParse(t).success, t);
    }
  });
});

describe("per-key grounding rule (§5)", () => {
  test("corporate affiliation grounds employer ONLY", () => {
    assert.equal(canGroundIdentityKey("corporate_affiliation", "employer"), true);
    for (const key of ["job_title", "team", "manager", "location", "personal_site"] as const) {
      assert.equal(
        canGroundIdentityKey("corporate_affiliation", key),
        false,
        `corporate domain must not ground ${key}`,
      );
    }
  });

  test("weak_mentions grounds NOTHING (evidence-only never promotes, invariant 6)", () => {
    for (const key of PROJECTION_IDENTITY_KEYS) {
      assert.equal(canGroundIdentityKey("weak_mentions", key), false, key);
    }
  });

  test("user + directory + self-authored + corroborated ground any owned key", () => {
    const strong: GroundingTier[] = [
      "user_correction",
      "user_profile_edit",
      "directory_verified",
      "self_authored_profile_or_signature",
      "corroborated_public_or_cold_start",
    ];
    for (const tier of strong) {
      for (const key of PROJECTION_IDENTITY_KEYS) {
        assert.equal(canGroundIdentityKey(tier, key), true, `${tier} should ground ${key}`);
      }
    }
  });

  test("PROJECTION_IDENTITY_KEYS are real fact keys and recognized by the guard", () => {
    for (const key of PROJECTION_IDENTITY_KEYS) {
      assert.ok(isUserFactKey(key), key);
      assert.ok(isProjectionIdentityKey(key), key);
    }
    assert.equal(isProjectionIdentityKey("birthday"), false);
    assert.equal(isProjectionIdentityKey("not_a_key"), false);
  });
});

describe("affiliationGroundingTier — the 'no grounding, no row' contract (§4a)", () => {
  test("only a corporate domain grounds (employer); everything else is null", () => {
    assert.equal(affiliationGroundingTier("corporate_domain"), "corporate_affiliation");
    assert.equal(affiliationGroundingTier("consumer_email"), null);
    assert.equal(affiliationGroundingTier("service_or_role_account"), null);
    // ambiguous needs corroboration (a later slice) — alone it grounds nothing
    assert.equal(affiliationGroundingTier("ambiguous_domain"), null);
  });

  test("end-to-end: a corporate account grounds employer, a personal one does not", () => {
    // Work account → corporate_domain → corporate_affiliation → grounds employer.
    const work = classifyEmailDomain({ email: "yash@oliv.ai" });
    assert.equal(work, "corporate_domain");
    const workTier = affiliationGroundingTier(work as DomainClass);
    assert.ok(workTier && canGroundIdentityKey(workTier, "employer"));

    // Personal Gmail → consumer_email → no tier → no employer row materializes.
    const personal = classifyEmailDomain({ email: "yashgouravkar@gmail.com" });
    assert.equal(personal, "consumer_email");
    assert.equal(affiliationGroundingTier(personal as DomainClass), null);
  });
});

describe("user_org_affiliation observation kind wiring", () => {
  test("is a legal kind for the gmail source, illegal for unrelated sources", () => {
    assert.equal(isObservationKindForSource("gmail", "user_org_affiliation"), true);
    assert.equal(isObservationKindForSource("github", "user_org_affiliation"), false);
    assert.equal(isObservationKindForSource("user", "user_org_affiliation"), false);
  });

  test("observationInsertSchema accepts a user-subject affiliation observation", () => {
    const parsed = observationInsertSchema.safeParse({
      userId: "usr_1",
      source: "gmail",
      kind: "user_org_affiliation",
      occurredAt: new Date("2026-06-29T00:00:00Z"),
      familyKey: "gmail:affiliation:oliv.ai",
      evidenceHash: "h1",
      subjectIdentity: { kind: "user" },
      payload: { orgDomain: "oliv.ai", domainClass: "corporate_domain" },
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(parsed.data?.subjectIdentity, { kind: "user" });
  });

  test("a gmail row may not carry a github kind (source×kind pair still closed)", () => {
    assert.equal(isObservationKindForSource("gmail", "github_push"), false);
  });
});
