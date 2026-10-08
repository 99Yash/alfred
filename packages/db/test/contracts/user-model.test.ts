import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CANONICAL_FACT_KEYS,
  canonicalizeFactKey,
  canonicalizeIdentityValue,
  entityKindClassificationSchema,
  ENTITY_NODE_KINDS,
  gmailEmailMessagePayloadSchema,
  FACT_KEY_ALIASES,
  identityRefSchema,
  identityValueMatchesKind,
  IDENTITY_ANCHOR_TIER,
  identityAnchorRank,
  isHardPersonBridge,
  isImmutableAccountBridge,
  isPersonScorable,
  isObservationKindForSource,
  MAX_IDENTITY_VALUE_BYTES,
  MAX_EVIDENCE_HASH_BYTES,
  MAX_FAMILY_KEY_BYTES,
  NON_PERSON_ENTITY_KINDS,
  OBSERVATION_SOURCE_RANK,
  observationInsertSchema,
  observationParticipantsSchema,
  observationSourceKindSchema,
  observationSourceSchema,
  observationSubjectSchema,
  isFactKey,
  isUserFactKey,
  PROJECTION_RUN_STATUS,
  projectionCursorValueSchema,
  projectionRunStatusSchema,
  projectionSourceHighWatermarkSchema,
  STANDING_INSTRUCTION_KEY,
} from "@alfred/contracts";
import { computeStableEntityId, makeEntityNodeInsert } from "@alfred/db/helpers";

describe("computeStableEntityId", () => {
  const secret = "stable namespace secret for tests";

  const input = {
    userId: "usr_test",
    identityKind: "email" as const,
    normalizedValue: "person@example.com",
  };

  test("pins the stable HMAC id contract", () => {
    assert.equal(computeStableEntityId(secret, input), "ent_heqb3j5f3jihmydfr5yuddb5qu");
    assert.equal(computeStableEntityId(secret, input), computeStableEntityId(secret, input));
  });

  test("emits the compact 128-bit base32 id shape", () => {
    const id = computeStableEntityId(secret, input);
    assert.match(id, /^ent_[a-z2-7]{26}$/);
  });

  test("is sensitive to every FK-defining input field and the namespace secret", () => {
    const baseline = computeStableEntityId(secret, input);

    assert.notEqual(computeStableEntityId(secret, { ...input, userId: "usr_other" }), baseline);
    // `slack_id` has no format rule, so the email value stays legal and only the kind changes.
    assert.notEqual(
      computeStableEntityId(secret, { ...input, identityKind: "slack_id" }),
      baseline,
    );
    assert.notEqual(
      computeStableEntityId(secret, { ...input, normalizedValue: "other@example.com" }),
      baseline,
    );
    assert.notEqual(computeStableEntityId(`${secret}!`, input), baseline);
  });

  test("fails closed on a blank or short namespace secret (never mints a guessable id)", () => {
    // `ENTITY_ID_NAMESPACE` is optional, so `?? ""` at a caller must throw here.
    assert.throws(() => computeStableEntityId("", input), /at least 32 chars/);
    assert.throws(() => computeStableEntityId("   ", input), /at least 32 chars/);
    assert.throws(() => computeStableEntityId("short-secret", input), /at least 32 chars/);
    assert.throws(() => computeStableEntityId("a".repeat(31), input), /at least 32 chars/);
    assert.doesNotThrow(() => computeStableEntityId("a".repeat(32), input));
  });

  test("fails closed on an empty or whitespace-padded id input (no bad-anchor merge magnet)", () => {
    // An empty input mints one id that every unknown identity merges onto.
    const valid = "a".repeat(40);
    assert.throws(() => computeStableEntityId(valid, { ...input, userId: "" }), /userId must be/);
    assert.throws(() => computeStableEntityId(valid, { ...input, userId: "  " }), /userId must be/);
    assert.throws(
      () => computeStableEntityId(valid, { ...input, userId: " usr_test " }),
      /userId must be/,
    );
    assert.throws(
      () => computeStableEntityId(valid, { ...input, normalizedValue: "" }),
      /normalizedValue must be/,
    );
    assert.throws(
      () => computeStableEntityId(valid, { ...input, normalizedValue: " person@example.com " }),
      /normalizedValue must be/,
    );
    assert.doesNotThrow(() => computeStableEntityId(valid, input));
  });

  test("rejects surrounding whitespace so a stray space can't silently remint every id", () => {
    // A padded secret would HMAC to different ids than the trimmed one.
    const valid = `${"a".repeat(40)}`;
    assert.doesNotThrow(() => computeStableEntityId(valid, input));
    assert.throws(() => computeStableEntityId(` ${valid}`, input), /whitespace/);
    assert.throws(() => computeStableEntityId(`${valid} `, input), /whitespace/);
    assert.throws(() => computeStableEntityId(`\t${valid}\n`, input), /whitespace/);
  });
});

describe("makeEntityNodeInsert", () => {
  const secret = "a".repeat(40);

  const firstSeenAt = new Date("2026-06-23T00:00:00.000Z");

  test("derives id and canonical_identity from ONE identity so they can't disagree", () => {
    const identity = { kind: "email" as const, value: "person@example.com" };
    const row = makeEntityNodeInsert(secret, "usr_test", identity, firstSeenAt);

    assert.deepEqual(row.canonicalIdentity, identity);
    assert.equal(row.firstSeenAt, firstSeenAt);
    assert.equal(
      row.id,
      computeStableEntityId(secret, {
        userId: "usr_test",
        identityKind: identity.kind,
        normalizedValue: identity.value,
      }),
    );
    // A replay that re-derives the id from the row gets the same id.
    assert.equal(
      computeStableEntityId(secret, {
        userId: row.userId,
        identityKind: row.canonicalIdentity.kind,
        normalizedValue: row.canonicalIdentity.value,
      }),
      row.id,
    );
  });

  test("runtime-parses the identity so a coerced bad kind/value can't mint a node", () => {
    // A payload read through `any` can carry a bad kind or value past the type.
    assert.throws(
      () =>
        makeEntityNodeInsert(
          secret,
          "usr_test",
          { kind: "not_a_kind", value: "x" } as never,
          firstSeenAt,
        ),
      /invalid|enum|expected/i,
    );
    assert.throws(
      () =>
        makeEntityNodeInsert(
          secret,
          "usr_test",
          { kind: "email", value: "Person@X.com" },
          firstSeenAt,
        ),
      /canonical/,
    );
  });

  test("fails closed on a bad anchor (delegates to computeStableEntityId)", () => {
    assert.throws(
      () =>
        makeEntityNodeInsert(
          secret,
          "usr_test",
          { kind: "email", value: " padded@x.com " },
          firstSeenAt,
        ),
      // The contract parse rejects it before the digest.
      /whitespace|canonical/,
    );
    assert.throws(
      () =>
        makeEntityNodeInsert("short", "usr_test", { kind: "email", value: "p@x.com" }, firstSeenAt),
      /at least 32 chars/,
    );
  });
});

describe("identityAnchorRank", () => {
  test("ranks the merge survivor anchors explicitly", () => {
    assert.equal(
      identityAnchorRank({ kind: "email", userPinned: true }),
      IDENTITY_ANCHOR_TIER.userPinned,
    );
    // An unverified directory id drops below email (D2/D3).
    assert.equal(
      identityAnchorRank({ kind: "google_directory_id", verified: true }),
      IDENTITY_ANCHOR_TIER.directoryVerified,
    );
    assert.equal(
      identityAnchorRank({ kind: "google_directory_id" }),
      IDENTITY_ANCHOR_TIER.providerAccountId,
    );
    assert.equal(identityAnchorRank({ kind: "email" }), IDENTITY_ANCHOR_TIER.email);
    assert.equal(
      identityAnchorRank({ kind: "github_user_id" }),
      IDENTITY_ANCHOR_TIER.providerAccountId,
    );
    assert.equal(identityAnchorRank({ kind: "domain" }), IDENTITY_ANCHOR_TIER.providerAccountId);
    assert.equal(identityAnchorRank({ kind: "github_login" }), IDENTITY_ANCHOR_TIER.providerHandle);
    assert.equal(identityAnchorRank({ kind: "phone" }), IDENTITY_ANCHOR_TIER.provisional);
  });

  test("ranks the non-person (repository/project) node anchors", () => {
    assert.equal(
      identityAnchorRank({ kind: "github_repository_id" }),
      IDENTITY_ANCHOR_TIER.providerAccountId,
    );
    assert.equal(
      identityAnchorRank({ kind: "integration_object_key" }),
      IDENTITY_ANCHOR_TIER.providerAccountId,
    );
    // `owner/repo` can be renamed, so it ranks as a handle.
    assert.equal(
      identityAnchorRank({ kind: "github_repository_full_name" }),
      IDENTITY_ANCHOR_TIER.providerHandle,
    );
  });
});

describe("projectionRunStatusSchema", () => {
  test("accepts only the closed projection run statuses", () => {
    assert.deepEqual(PROJECTION_RUN_STATUS, ["running", "completed", "failed"]);
    assert.equal(projectionRunStatusSchema.parse("running"), "running");
    assert.throws(() => projectionRunStatusSchema.parse("stalled"));
  });
});

describe("entity kind classifier contracts", () => {
  test("keeps unknown as a retained but non-person-scorable node kind", () => {
    assert.ok(ENTITY_NODE_KINDS.includes("unknown"));
    assert.ok(NON_PERSON_ENTITY_KINDS.includes("unknown"));
    assert.equal(isPersonScorable("person"), true);

    for (const kind of NON_PERSON_ENTITY_KINDS) {
      assert.equal(isPersonScorable(kind), false);
    }
  });

  test("types classifier provenance for versioned profiles", () => {
    const parsed = entityKindClassificationSchema.parse({
      kind: "unknown",
      confidence: 0.4,
      bestGuess: "person",
      evidenceCodes: ["gmail.low_confidence_mailbox"],
      researchStatus: "not_started",
    });

    assert.equal(parsed.kind, "unknown");
    assert.equal(parsed.bestGuess, "person");
    assert.equal(parsed.researchStatus, "not_started");

    assert.throws(() =>
      entityKindClassificationSchema.parse({
        kind: "unknown",
        confidence: 0.4,
        bestGuess: "unknown",
        evidenceCodes: ["bad.best_guess"],
      }),
    );
    assert.throws(() =>
      entityKindClassificationSchema.parse({
        kind: "person",
        confidence: 1.2,
        evidenceCodes: ["bad.confidence"],
      }),
    );
    assert.throws(() =>
      entityKindClassificationSchema.parse({
        kind: "person",
        confidence: 0.9,
        evidenceCodes: [],
        extra: true,
      }),
    );
  });
});

describe("user_facts key gates", () => {
  test("isFactKey covers only the durable fact ontology, not the standing-instruction key", () => {
    assert.equal(isFactKey("employer"), true);
    assert.equal(isFactKey("timezone"), true);
    assert.equal(isFactKey(STANDING_INSTRUCTION_KEY), false);
    assert.equal(isFactKey("zoom_meeting_passcode"), false);
  });

  test("isUserFactKey is the column gate: ontology PLUS the standing-instruction key", () => {
    assert.equal(isUserFactKey("employer"), true);
    // A standing instruction is a legal user_facts.key, so the column gate must accept it.
    assert.equal(isUserFactKey(STANDING_INSTRUCTION_KEY), true);
    assert.equal(isUserFactKey("zoom_meeting_passcode"), false);
  });
});

describe("canonicalizeFactKey (#330 — one fact-key ontology)", () => {
  test("passes an exact canonical key through unchanged (not an alias)", () => {
    for (const key of ["employer", "job_title", "location", "full_name", "personal_site"]) {
      assert.deepEqual(canonicalizeFactKey(key), { ok: true, key, wasAlias: false });
    }

    for (const key of CANONICAL_FACT_KEYS) {
      const r = canonicalizeFactKey(key);
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.key, key);
    }
  });

  test("maps the listed legacy/producer spellings onto their canonical key", () => {
    const cases: Array<[string, string]> = [
      ["current_company", "employer"],
      ["company", "employer"],
      ["company_name", "employer"],
      ["current_role", "job_title"],
      ["role", "job_title"],
      ["current_work", "work_summary"],
      ["current_location", "location"],
      ["name", "full_name"],
      ["personal_website", "personal_site"],
    ];

    for (const [raw, canonical] of cases) {
      assert.deepEqual(canonicalizeFactKey(raw), {
        ok: true,
        key: canonical,
        wasAlias: true,
        originalKey: raw,
      });
    }

    // The alias map is exactly this set.
    assert.deepEqual(new Set(Object.keys(FACT_KEY_ALIASES)), new Set(cases.map(([raw]) => raw)));
  });

  test("rejects near-miss keys that are NOT explicit aliases", () => {
    for (const key of [
      "website",
      "url",
      "homepage",
      "company_url",
      "employer_name",
      "zoom_passcode",
    ]) {
      assert.deepEqual(canonicalizeFactKey(key), { ok: false, reason: "unknown_key" });
    }
  });

  test("normalizes relationship:<email> and rejects an unparseable suffix", () => {
    assert.deepEqual(canonicalizeFactKey("relationship:alice@oliv.ai"), {
      ok: true,
      key: "relationship:alice@oliv.ai",
      wasAlias: false,
    });
    // A folded email suffix counts as an alias.
    assert.deepEqual(canonicalizeFactKey("relationship:Alice@Oliv.AI"), {
      ok: true,
      key: "relationship:alice@oliv.ai",
      wasAlias: true,
      originalKey: "relationship:Alice@Oliv.AI",
    });

    for (const bad of [
      "relationship:github.com",
      "relationship:Alfred",
      "relationship:Some Person",
      "relationship:",
    ]) {
      assert.deepEqual(canonicalizeFactKey(bad), { ok: false, reason: "unknown_key" });
    }
  });

  test("accepts pref:<name> (freeform suffix), rejects a bare pref:", () => {
    assert.deepEqual(canonicalizeFactKey("pref:tone"), {
      ok: true,
      key: "pref:tone",
      wasAlias: false,
    });
    assert.deepEqual(canonicalizeFactKey("pref:"), { ok: false, reason: "unknown_key" });
  });
});

describe("user-model observation contracts", () => {
  test("ranks user above alfred_chat above first-party integrations", () => {
    assert.equal(OBSERVATION_SOURCE_RANK.user < OBSERVATION_SOURCE_RANK.alfred_chat, true);
    assert.equal(OBSERVATION_SOURCE_RANK.alfred_chat < OBSERVATION_SOURCE_RANK.gmail, true);
    assert.equal(OBSERVATION_SOURCE_RANK.gmail, OBSERVATION_SOURCE_RANK.google_account);
  });

  test("lists only sources that have a writer (#987)", () => {
    assert.equal(observationSourceSchema.safeParse("google_directory").success, false);
    assert.equal(observationSourceSchema.safeParse("enrichment").success, false);
    assert.equal(observationSourceSchema.safeParse("github").success, false);
  });

  test("validates the participant envelope reducers must write", () => {
    const parsed = observationParticipantsSchema.parse({
      items: [
        {
          identity: { kind: "email", value: "person@example.com" },
          role: "from",
          displayName: "Person Example",
        },
      ],
      recipientCount: 1,
      listId: null,
    });

    assert.equal(parsed.items[0]?.identity.kind, "email");
    assert.throws(() =>
      observationParticipantsSchema.parse({
        items: [{ identity: { kind: "email", value: "person@example.com" }, role: "sender" }],
        recipientCount: 1,
      }),
    );
  });

  test("rejects an under-written recipientCount so a blast can't bypass the fan-out cutoff", () => {
    const recipientItems = Array.from({ length: 50 }, (_, i) => ({
      identity: { kind: "email" as const, value: `r${i}@example.com` },
      role: "to" as const,
    }));

    // Seen in prod: a 50-person blast with recipientCount 1 read as a 1:1.
    assert.throws(() =>
      observationParticipantsSchema.parse({ items: recipientItems, recipientCount: 1 }),
    );

    // A truncated list (count above items) is fine.
    assert.equal(
      observationParticipantsSchema.parse({ items: recipientItems, recipientCount: 50 })
        .recipientCount,
      50,
    );
    assert.equal(
      observationParticipantsSchema.parse({
        items: recipientItems.slice(0, 5),
        recipientCount: 50,
      }).recipientCount,
      50,
    );
    // `from` is not a recipient.
    assert.equal(
      observationParticipantsSchema.parse({
        items: [
          { identity: { kind: "email", value: "sender@example.com" }, role: "from" },
          { identity: { kind: "email", value: "r@example.com" }, role: "to" },
        ],
        recipientCount: 1,
      }).recipientCount,
      1,
    );
  });

  test("counts GitHub audience roles toward fan-out, not just email recipients", () => {
    // Otherwise a GitHub blast slips under FAN_OUT_CUTOFF.
    const reviewers = Array.from({ length: 30 }, (_, i) => ({
      identity: { kind: "github_login" as const, value: `reviewer-${i}` },
      role: "reviewer" as const,
    }));

    assert.throws(() =>
      observationParticipantsSchema.parse({ items: reviewers, recipientCount: 0 }),
    );
    // The author is the sender side, like `from`.
    assert.equal(
      observationParticipantsSchema.parse({
        items: [
          { identity: { kind: "github_login", value: "author" }, role: "author" },
          { identity: { kind: "github_login", value: "rev" }, role: "reviewer" },
        ],
        recipientCount: 1,
      }).recipientCount,
      1,
    );
  });

  test("does NOT count committers toward fan-out (contributor metadata, not audience)", () => {
    // On a GitHub merge the committer is the bot `web-flow`. Counting committers
    // would make a busy PR look like a blast and drop its co-occurrence.
    const committers = Array.from({ length: 30 }, (_, i) => ({
      identity: { kind: "github_login" as const, value: `committer-${i}` },
      role: "committer" as const,
    }));

    assert.equal(
      observationParticipantsSchema.parse({ items: committers, recipientCount: 0 }).recipientCount,
      0,
    );
    // Only the reviewer counts.
    assert.equal(
      observationParticipantsSchema.parse({
        items: [
          { identity: { kind: "github_login", value: "web-flow" }, role: "committer" },
          { identity: { kind: "github_login", value: "rev" }, role: "reviewer" },
        ],
        recipientCount: 1,
      }).recipientCount,
      1,
    );
  });

  test("counts a recipient in multiple roles once (distinct identities, not rows)", () => {
    // Counting rows would reject a correct reducer that counts people.
    const dup = { kind: "email" as const, value: "dup@example.com" };
    assert.equal(
      observationParticipantsSchema.parse({
        items: [
          { identity: dup, role: "to" },
          { identity: dup, role: "cc" },
        ],
        recipientCount: 1,
      }).recipientCount,
      1,
    );
    const ghUser = { kind: "github_login" as const, value: "dev" };
    assert.equal(
      observationParticipantsSchema.parse({
        items: [
          { identity: ghUser, role: "reviewer" },
          { identity: ghUser, role: "assignee" },
        ],
        recipientCount: 1,
      }).recipientCount,
      1,
    );
    assert.throws(() =>
      observationParticipantsSchema.parse({
        items: [
          { identity: { kind: "email", value: "a@example.com" }, role: "to" },
          { identity: { kind: "email", value: "b@example.com" }, role: "cc" },
        ],
        recipientCount: 1,
      }),
    );
  });

  test("registers google_account for account-level identity affiliation", () => {
    // Account identity evidence is not a Gmail message.
    assert.equal(observationSourceSchema.parse("google_account"), "google_account");
    assert.equal(OBSERVATION_SOURCE_RANK.google_account, OBSERVATION_SOURCE_RANK.gmail);
    assert.equal(isObservationKindForSource("google_account", "user_org_affiliation"), true);
    assert.equal(isObservationKindForSource("gmail", "user_org_affiliation"), false);
  });

  test("observation subject is an identity OR the user themselves ({kind:'user'})", () => {
    // The user has no IdentityRef, so self-facts need their own subject shape.
    assert.deepEqual(observationSubjectSchema.parse({ kind: "user" }), { kind: "user" });
    assert.deepEqual(observationSubjectSchema.parse({ kind: "email", value: "p@example.com" }), {
      kind: "email",
      value: "p@example.com",
    });
    assert.throws(() => observationSubjectSchema.parse({ kind: "user", value: "x" }));
    assert.throws(() => observationSubjectSchema.parse({ kind: "self" }));
  });

  test("identity value rejects empty + surrounding whitespace (matches the mint chokepoint)", () => {
    // Match `computeStableEntityId`, or a valid observation later fails projection.
    assert.deepEqual(observationSubjectSchema.parse({ kind: "email", value: "p@example.com" }), {
      kind: "email",
      value: "p@example.com",
    });
    assert.throws(() =>
      observationSubjectSchema.parse({ kind: "email", value: " p@example.com " }),
    );
    assert.throws(() =>
      observationSubjectSchema.parse({ kind: "email", value: "p@example.com\n" }),
    );
    assert.throws(() => observationSubjectSchema.parse({ kind: "email", value: "  " }));
    assert.throws(() => observationSubjectSchema.parse({ kind: "email", value: "" }));
  });

  test("identity value rejects values over the DB byte cap", () => {
    // The DB caps `octet_length(value)`, so count UTF-8 bytes, not `.length`.
    assert.deepEqual(
      identityRefSchema.parse({
        kind: "slack_id",
        value: "x".repeat(MAX_IDENTITY_VALUE_BYTES),
      }),
      {
        kind: "slack_id",
        value: "x".repeat(MAX_IDENTITY_VALUE_BYTES),
      },
    );
    assert.throws(() =>
      identityRefSchema.parse({
        kind: "slack_id",
        value: "x".repeat(MAX_IDENTITY_VALUE_BYTES + 1),
      }),
    );

    const exactly1024Bytes = "é".repeat(MAX_IDENTITY_VALUE_BYTES / 2);
    assert.deepEqual(identityRefSchema.parse({ kind: "slack_id", value: exactly1024Bytes }), {
      kind: "slack_id",
      value: exactly1024Bytes,
    });
    assert.throws(() =>
      identityRefSchema.parse({ kind: "slack_id", value: `${exactly1024Bytes}a` }),
    );
  });

  test("canonicalizes case-insensitive identity kinds and leaves opaque ids untouched", () => {
    // Case-folded kinds, or one identity mints two ids (D2).
    assert.equal(canonicalizeIdentityValue("email", "Person@Example.com"), "person@example.com");
    assert.equal(canonicalizeIdentityValue("domain", "Example.COM"), "example.com");
    assert.equal(canonicalizeIdentityValue("github_login", "OctoCat"), "octocat");
    assert.equal(
      canonicalizeIdentityValue("github_repository_full_name", "Owner/Repo"),
      "owner/repo",
    );
    assert.equal(canonicalizeIdentityValue("email", "  A@B.com "), "a@b.com");
    // Opaque ids keep their case.
    assert.equal(canonicalizeIdentityValue("slack_id", "U07ABC123"), "U07ABC123");
    assert.equal(canonicalizeIdentityValue("github_user_id", "583231"), "583231");
    assert.equal(canonicalizeIdentityValue("google_directory_id", "AbC123"), "AbC123");

    // The contract refine and the mint check rely on idempotence.
    for (const [kind, raw] of [
      ["email", "MixedCase@X.com"],
      ["github_login", "MixedCase"],
      ["slack_id", "U0XyZ"],
    ] as const) {
      const once = canonicalizeIdentityValue(kind, raw);
      assert.equal(canonicalizeIdentityValue(kind, once), once);
    }
  });

  test("identityRefSchema requires canonical values per kind (refuses non-canonical, never folds)", () => {
    assert.deepEqual(identityRefSchema.parse({ kind: "email", value: "p@example.com" }), {
      kind: "email",
      value: "p@example.com",
    });
    assert.deepEqual(identityRefSchema.parse({ kind: "github_login", value: "octocat" }), {
      kind: "github_login",
      value: "octocat",
    });
    // The schema refuses; it does not lowercase.
    assert.throws(
      () => identityRefSchema.parse({ kind: "email", value: "Person@Example.com" }),
      /canonical/,
    );
    assert.throws(
      () => identityRefSchema.parse({ kind: "github_repository_full_name", value: "Owner/Repo" }),
      /canonical/,
    );
    assert.deepEqual(identityRefSchema.parse({ kind: "slack_id", value: "U07ABC123" }), {
      kind: "slack_id",
      value: "U07ABC123",
    });
  });

  test("identityValueMatchesKind enforces per-kind value FORMATS (canonical isn't enough)", () => {
    const valid: [Parameters<typeof identityValueMatchesKind>[0], string][] = [
      ["email", "person@example.com"],
      ["domain", "example.com"],
      ["domain", "mail.corp.example.co.uk"],
      ["github_login", "octocat"],
      ["github_login", "a-b-c"],
      ["github_user_id", "583231"],
      ["github_repository_id", "1296269"],
      ["github_repository_full_name", "owner/repo"],
      ["github_repository_full_name", "octo-org/some.repo_name"],
      ["integration_object_key", "clickup:task:abc123"],
      ["integration_object_key", "notion:page:8a1f-1234-uuid"],
    ];

    for (const [kind, value] of valid) {
      assert.equal(identityValueMatchesKind(kind, value), true, `${kind}=${value} should be valid`);
    }

    // Canonical but malformed.
    const invalid: [Parameters<typeof identityValueMatchesKind>[0], string][] = [
      ["email", "not-an-email"],
      ["email", "a@b"], // no dotted TLD
      ["email", "a@-bad.com"], // domain label with a leading hyphen
      ["email", "a@bad..com"], // empty domain label
      ["email", "a@bad.com-"], // domain label with a trailing hyphen
      ["email", "a@bad.123"], // all-numeric TLD
      // Keep the `\x00` escape. A literal NUL byte makes rg/grep treat this file as binary.
      ["email", "a\x00b@example.com"],
      ["domain", "localhost"], // single label, no TLD
      ["domain", "-bad.example.com"], // leading hyphen
      ["domain", "example.123"], // all-numeric TLD
      ["github_login", "-octocat"], // leading hyphen
      ["github_login", "octo--cat"], // consecutive hyphens
      ["github_user_id", "abc"], // not numeric
      ["github_user_id", "0123"], // leading zero
      ["github_repository_id", "12x"],
      ["github_repository_full_name", "owner"], // no slash
      ["github_repository_full_name", "owner/.."], // path traversal
      ["integration_object_key", "barekey"], // not provider:kind:id
      ["integration_object_key", "clickup:task"], // missing externalId
    ];

    for (const [kind, value] of invalid) {
      assert.equal(
        identityValueMatchesKind(kind, value),
        false,
        `${kind}=${value} should be invalid`,
      );
    }

    // Kinds with no format rule pass on the floor alone.
    assert.equal(identityValueMatchesKind("slack_id", "U07ABC123"), true);
    assert.equal(identityValueMatchesKind("notion_user_id", "anything-goes"), true);
    assert.equal(identityValueMatchesKind("phone", "+15551234567"), true);

    // Both the schema and the mint reject it.
    assert.throws(
      () => identityRefSchema.parse({ kind: "github_user_id", value: "abc" }),
      /valid format/,
    );
    assert.throws(
      () =>
        computeStableEntityId("a".repeat(32), {
          userId: "usr_test",
          identityKind: "email",
          normalizedValue: "not-an-email",
        }),
      /valid format/,
    );
  });

  test("validates projection cursor values used by run-scoped cursors", () => {
    assert.equal(
      projectionCursorValueSchema.parse({
        lastObservationId: "obs_abc",
        occurredAt: "2026-06-23T00:00:00.000Z",
      }).lastObservationId,
      "obs_abc",
    );
    assert.throws(() => projectionCursorValueSchema.parse({ occurredAt: "not-a-date" }));
  });

  test("closes the source→kind vocabulary so a kind can't ride the wrong source", () => {
    assert.equal(isObservationKindForSource("gmail", "email_message"), true);
    assert.equal(isObservationKindForSource("google_account", "user_org_affiliation"), true);
    assert.equal(isObservationKindForSource("user", "user_correction"), true);
    // Each is valid alone, but not together.
    assert.equal(isObservationKindForSource("gmail", "user_org_affiliation"), false);
    assert.equal(isObservationKindForSource("google_account", "email_message"), false);

    assert.equal(
      observationSourceKindSchema.parse({ source: "alfred_chat", kind: "user_correction" }).kind,
      "user_correction",
    );
    assert.throws(() =>
      observationSourceKindSchema.parse({ source: "gmail", kind: "user_org_affiliation" }),
    );
    assert.throws(() =>
      observationSourceKindSchema.parse({ source: "google_account", kind: "email_message" }),
    );
  });

  test("keys source high-watermarks by ObservationSource, rejecting typo keys", () => {
    // Partial: a run lists only the sources it read.
    assert.deepEqual(projectionSourceHighWatermarkSchema.parse({}), {});
    assert.equal(
      projectionSourceHighWatermarkSchema.parse({ gmail: { lastObservationId: "obs_1" } }).gmail
        ?.lastObservationId,
      "obs_1",
    );
    assert.throws(() =>
      projectionSourceHighWatermarkSchema.parse({ gihub: { lastObservationId: "obs_1" } }),
    );
  });

  test("uses one hard person-bridge predicate for email + gated account ids", () => {
    // Merge code must call the predicate, not read IMMUTABLE_ACCOUNT_ID_KINDS.
    // A directory id counts only when verified. Email bridges but is not an account id.
    assert.equal(isImmutableAccountBridge({ kind: "github_user_id" }), true);
    assert.equal(isImmutableAccountBridge({ kind: "slack_id" }), false);
    assert.equal(isImmutableAccountBridge({ kind: "notion_user_id" }), false);
    assert.equal(isImmutableAccountBridge({ kind: "google_directory_id", verified: true }), true);
    assert.equal(isImmutableAccountBridge({ kind: "google_directory_id" }), false);
    assert.equal(isImmutableAccountBridge({ kind: "google_directory_id", verified: false }), false);
    assert.equal(isImmutableAccountBridge({ kind: "domain" }), false);
    assert.equal(isImmutableAccountBridge({ kind: "github_repository_id" }), false);
    assert.equal(isImmutableAccountBridge({ kind: "email" }), false);

    assert.equal(isHardPersonBridge({ kind: "email" }), true);
    assert.equal(isHardPersonBridge({ kind: "github_user_id" }), true);
    assert.equal(isHardPersonBridge({ kind: "google_directory_id", verified: true }), true);
    assert.equal(isHardPersonBridge({ kind: "google_directory_id" }), false);
    assert.equal(isHardPersonBridge({ kind: "slack_id" }), false);
    assert.equal(isHardPersonBridge({ kind: "notion_user_id" }), false);
    assert.equal(isHardPersonBridge({ kind: "domain" }), false);
  });
});

describe("observationInsertSchema (the HARD write-boundary parser)", () => {
  const minimal = {
    userId: "usr_test",
    source: "gmail" as const,
    kind: "email_message" as const,
    occurredAt: new Date("2026-06-23T00:00:00.000Z"),
    familyKey: "gmail:abc123",
    evidenceHash: "sha256:deadbeef",
    subjectIdentity: { kind: "email" as const, value: "person@example.com" },
    payload: gmailPayload({ documentId: "doc_1", messageId: "msg_1" }),
  };

  test("accepts a minimal valid observation and applies column-matching defaults", () => {
    const parsed = observationInsertSchema.parse(minimal);
    assert.deepEqual(parsed.participants, { items: [], recipientCount: 0 });
    assert.equal(parsed.payload.provider, "gmail");
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.reducerVersion, 1);
    assert.equal(parsed.objectIdentity, undefined);
    assert.equal(parsed.supersedesObservationId, undefined);
  });

  test("closes the half-open vocabulary: a kind not valid for its source is rejected", () => {
    // `user_correction` is a real kind, but not for `gmail`.
    assert.throws(
      () => observationInsertSchema.parse({ ...minimal, kind: "user_correction" }),
      /not valid for its source/,
    );
    assert.doesNotThrow(() =>
      observationInsertSchema.parse({
        ...minimal,
        source: "user",
        kind: "user_correction",
        subjectIdentity: { kind: "user" },
        familyKey: "user:correction:abc",
      }),
    );
  });

  test("pins the idempotency keys non-empty, edge-whitespace-free, and byte-bounded", () => {
    for (const bad of ["", " ", "x ", " x", "x\t"]) {
      assert.throws(() => observationInsertSchema.parse({ ...minimal, familyKey: bad }));
      assert.throws(() => observationInsertSchema.parse({ ...minimal, evidenceHash: bad }));
    }

    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        familyKey: "f".repeat(MAX_FAMILY_KEY_BYTES + 1),
      }),
    );
    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        evidenceHash: "e".repeat(MAX_EVIDENCE_HASH_BYTES + 1),
      }),
    );
  });

  test("inherits the identity canonical + format refines on subject and object", () => {
    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        subjectIdentity: { kind: "email", value: "Person@example.com" },
      }),
    );
    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        objectIdentity: { kind: "github_user_id", value: "not-a-number" },
      }),
    );
    assert.doesNotThrow(() =>
      observationInsertSchema.parse({
        ...minimal,
        objectIdentity: { kind: "github_user_id", value: "12345" },
      }),
    );
  });

  test("accepts the {kind:'user'} self-subject for user-authored observations", () => {
    const parsed = observationInsertSchema.parse({
      userId: "usr_test",
      source: "user",
      kind: "user_standing_instruction",
      occurredAt: new Date("2026-06-23T00:00:00.000Z"),
      familyKey: "user:standing:tz",
      evidenceHash: "sha256:cafe",
      subjectIdentity: { kind: "user" },
    });

    assert.deepEqual(parsed.subjectIdentity, { kind: "user" });
  });

  test("carries the participants fan-out refine through (a blast can't masquerade as a 1:1)", () => {
    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        participants: {
          items: [
            { identity: { kind: "email", value: "a@example.com" }, role: "to" },
            { identity: { kind: "email", value: "b@example.com" }, role: "cc" },
          ],
          recipientCount: 1,
        },
      }),
    );
  });

  test("rejects unknown keys (strict) so a typo'd field can't slip into the log", () => {
    assert.throws(() =>
      observationInsertSchema.parse({ ...minimal, occured_at: new Date() } as never),
    );
  });

  test("validates gmail email_message payloads by kind", () => {
    const payload = gmailPayload({ documentId: "doc_1", messageId: "msg_1" });
    assert.doesNotThrow(() => gmailEmailMessagePayloadSchema.parse(payload));
    assert.doesNotThrow(() => observationInsertSchema.parse({ ...minimal, payload }));

    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        payload: {
          ...payload,
          provider: "not-gmail",
        },
      }),
    );
    assert.throws(() =>
      observationInsertSchema.parse({
        ...minimal,
        payload: {
          ...payload,
          headers: { ...payload.headers, references: "not-array" },
        },
      }),
    );
  });
});

function gmailPayload(args: { documentId: string; messageId: string }) {
  return {
    provider: "gmail",
    documentId: args.documentId,
    messageId: args.messageId,
    threadId: "thread_1",
    accountId: "acct_1",
    isSent: false,
    subject: "Subject",
    subjectHash: "sha256:abc",
    headers: {
      messageId: "<message@example.com>",
      inReplyTo: null,
      references: [],
      listId: null,
      listUnsubscribe: null,
      replyTo: null,
      deliveredTo: null,
      autoSubmitted: null,
      precedence: null,
    },
  };
}
