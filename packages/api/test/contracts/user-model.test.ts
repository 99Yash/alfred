import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IDENTITY_ANCHOR_TIER,
  identityAnchorRank,
  isObservationKindForSource,
  OBSERVATION_SOURCE_RANK,
  observationParticipantsSchema,
  observationSourceKindSchema,
  observationSourceSchema,
  PROJECTION_RUN_STATUS,
  projectionCursorValueSchema,
  projectionRunStatusSchema,
  projectionSourceHighWatermarkSchema,
} from "@alfred/contracts";
import { computeStableEntityId } from "@alfred/db/helpers";

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
    assert.notEqual(
      computeStableEntityId(secret, { ...input, identityKind: "github_login" }),
      baseline,
    );
    assert.notEqual(
      computeStableEntityId(secret, { ...input, normalizedValue: "other@example.com" }),
      baseline,
    );
    assert.notEqual(computeStableEntityId(`${secret}!`, input), baseline);
  });

  test("fails closed on a blank or short namespace secret (never mints a guessable id)", () => {
    // The env field is optional in P0, so the guard must live in the helper —
    // a caller doing `serverEnv().ENTITY_ID_NAMESPACE ?? ""` must throw, not
    // silently HMAC with an empty/known key (defeats the HMAC-not-SHA rationale).
    assert.throws(() => computeStableEntityId("", input), /at least 32 chars/);
    assert.throws(() => computeStableEntityId("   ", input), /at least 32 chars/);
    assert.throws(() => computeStableEntityId("short-secret", input), /at least 32 chars/);
    // A 31-char (whitespace-trimmed) secret is still rejected; 32 is the floor.
    assert.throws(() => computeStableEntityId(`  ${"a".repeat(31)}  `, input), /at least 32 chars/);
    assert.doesNotThrow(() => computeStableEntityId("a".repeat(32), input));
  });
});

describe("identityAnchorRank", () => {
  test("ranks the merge survivor anchors explicitly", () => {
    assert.equal(
      identityAnchorRank({ kind: "email", userPinned: true }),
      IDENTITY_ANCHOR_TIER.userPinned,
    );
    // A *verified* directory identity anchors at tier 2; an unverified one is
    // demoted below email to the provider-account tier (D2/D3).
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
});

describe("projectionRunStatusSchema", () => {
  test("accepts only the closed projection run statuses", () => {
    assert.deepEqual(PROJECTION_RUN_STATUS, ["running", "completed", "failed"]);
    assert.equal(projectionRunStatusSchema.parse("running"), "running");
    assert.throws(() => projectionRunStatusSchema.parse("stalled"));
  });
});

describe("user-model observation contracts", () => {
  test("keeps enrichment as a lower-precedence source than first-party integrations", () => {
    assert.equal(observationSourceSchema.parse("enrichment"), "enrichment");
    assert.equal(OBSERVATION_SOURCE_RANK.gmail < OBSERVATION_SOURCE_RANK.enrichment, true);
    assert.equal(OBSERVATION_SOURCE_RANK.user < OBSERVATION_SOURCE_RANK.alfred_chat, true);
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

    // The prod corruption this rail exists to kill: 50 enumerated recipients but
    // recipientCount: 1 — would let a 50-person blast read as a 1:1.
    assert.throws(() =>
      observationParticipantsSchema.parse({ items: recipientItems, recipientCount: 1 }),
    );

    // recipientCount >= enumerated recipients is accepted, including a truncated
    // blast (more recipients than enumerated) and the sender not being counted.
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
    // `from` is not a recipient, so it never inflates the required count.
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
    assert.equal(isObservationKindForSource("github", "github_push"), true);
    // The half-open bug: independently-valid source + kind that don't belong together.
    assert.equal(isObservationKindForSource("gmail", "github_push"), false);

    assert.equal(
      observationSourceKindSchema.parse({ source: "github", kind: "github_review" }).kind,
      "github_review",
    );
    assert.throws(() => observationSourceKindSchema.parse({ source: "gmail", kind: "github_push" }));
    // A source whose reducer isn't built yet accepts no kind.
    assert.throws(() =>
      observationSourceKindSchema.parse({ source: "clickup", kind: "email_message" }),
    );
  });

  test("keys source high-watermarks by ObservationSource, rejecting typo keys", () => {
    // Partial by design — a run consumes only the sources it touched.
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
});
