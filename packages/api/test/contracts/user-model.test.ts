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
});

describe("identityAnchorRank", () => {
  test("ranks the merge survivor anchors explicitly", () => {
    assert.equal(
      identityAnchorRank({ kind: "email", userPinned: true }),
      IDENTITY_ANCHOR_TIER.userPinned,
    );
    assert.equal(
      identityAnchorRank({ kind: "google_directory_id" }),
      IDENTITY_ANCHOR_TIER.directoryVerified,
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
