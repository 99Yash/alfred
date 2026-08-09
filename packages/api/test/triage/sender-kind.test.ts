import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ActiveEntityProfile } from "@alfred/assistant/knowledge";
import { senderExtractionEvent, senderKindSignalFromProfile } from "@alfred/assistant/triage";
import type { TriageClassification } from "@alfred/assistant/triage/classify";
import { applyFloors, type FloorContext, type FloorOutcome } from "@alfred/assistant/triage/floors";
import type { Observations } from "@alfred/assistant/triage/observations";
import type { SenderContextResult } from "@alfred/assistant/triage/sender-context";

function profile(overrides: Partial<ActiveEntityProfile>): ActiveEntityProfile {
  return {
    id: "eprof_1",
    userId: "user_1",
    projectionName: "user-model",
    projectionVersion: 1,
    projectionRunId: "prun_1",
    entityId: "ent_1",
    displayName: "Engineering",
    kind: "group",
    significanceComponents: {},
    lastSeenAt: null,
    provenance: {
      classification: {
        kind: "group",
        confidence: 0.99,
        evidenceCodes: ["gmail:list_id"],
        researchStatus: "not_needed",
      },
    },
    computedAt: new Date("2026-06-30T00:00:00.000Z"),
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  };
}

describe("senderKindSignalFromProfile", () => {
  test("returns a confident group/service demotion signal", () => {
    const signal = senderKindSignalFromProfile(
      profile({
        provenance: {
          classification: {
            kind: "group",
            confidence: 0.99,
            evidenceCodes: ["gmail:precedence:list", "gmail:list_id"],
            researchStatus: "not_needed",
          },
        },
      }),
    );

    assert.deepEqual(signal, {
      kind: "group",
      confidence: 0.99,
      evidenceCodes: ["gmail:list_id", "gmail:precedence:list"],
      entityId: "ent_1",
      displayName: "Engineering",
    });
  });

  test("does not demote weak group guesses or person profiles", () => {
    assert.equal(
      senderKindSignalFromProfile(
        profile({
          kind: "unknown",
          provenance: {
            classification: {
              kind: "unknown",
              bestGuess: "group",
              confidence: 0.58,
              evidenceCodes: ["email:local:group_weak"],
              researchStatus: "not_needed",
            },
          },
        }),
      ),
      null,
    );

    assert.equal(
      senderKindSignalFromProfile(
        profile({
          kind: "person",
          provenance: {
            classification: {
              kind: "person",
              confidence: 0.82,
              evidenceCodes: ["display:person_like"],
              researchStatus: "not_needed",
            },
          },
        }),
      ),
      null,
    );
  });

  test("requires classification provenance and threshold confidence", () => {
    assert.equal(senderKindSignalFromProfile(profile({ provenance: {} })), null);
    assert.equal(
      senderKindSignalFromProfile(
        profile({
          kind: "service",
          provenance: {
            classification: {
              kind: "service",
              confidence: 0.79,
              evidenceCodes: ["email:domain:service"],
              researchStatus: "not_needed",
            },
          },
        }),
      ),
      null,
    );
  });
});

test("senderExtractionEvent records the sender-kind demotion breadcrumb", () => {
  const event = senderExtractionEvent({
    senderContextResult: senderContextResult(),
    observations: observations(),
    audit: {
      firstPass: classification({ category: "action_needed", collabActivity: "other_activity" }),
      conflict: null,
      secondPass: null,
      secondPassFailure: null,
      floors: {
        override: { verdict: { kind: "keep" }, matched: false },
        senderKind: {
          verdict: {
            kind: "demote",
            key: "sender_kind_floor",
            note: "group sender sent passive collaboration activity",
            reason: "Sender-kind floor",
          },
          reason: "collab_passive_activity",
        },
        meeting: { verdict: { kind: "keep" }, reason: null },
      },
    },
    classification: classification({ collabActivity: "other_activity" }),
    todoSuggested: false,
    standingSuppression: null,
    standingSuppressionReadFailed: false,
  });

  assert.equal(event.senderKind, "group");
  assert.equal(event.senderKindConfidence, 0.99);
  assert.deepEqual(event.senderKindEvidenceCodes, ["gmail:list_id"]);
  assert.equal(event.senderKindDemotedPersonTreatment, true);
  assert.equal(event.senderKindDemotedCategory, true);
  assert.equal(event.senderKindDemotionReason, "collab_passive_activity");
  assert.equal(event.firstPassCollabActivity, "other_activity");
  assert.equal(event.finalCollabActivity, "other_activity");
  assert.equal(event.knownContact, false);
  assert.equal(event.senderRelationship, null);
});

test("senderExtractionEvent carries each floor's real outcome", () => {
  // Fed the FOLD's own output rather than a hand-built audit: the projections
  // are the seam between `applyFloors` and the persisted row, so the test that
  // guards them should cross it. Two runs on the same recap subject, one with a
  // leaked secret in the body — the same input reaches the record through two
  // floors whose fields share no naming convention.
  const recap = { subject: "Meeting notes: Eng standup", effectiveAuthor: "person" as const };

  const escalated = eventFor(
    applyFloors(classification({ category: "meeting" }), {
      ...floorContext(),
      ...recap,
      signalText: "an api key was leaked in the public repo",
    }),
  );
  assert.equal(escalated.floorMatched, true);
  assert.equal(escalated.floorForced, true);
  assert.equal(escalated.finalCategory, "urgent");
  // The override floor moved the category off `meeting` before the gate saw it,
  // so the meeting floor reports its own "did not fire" — a REPORT, not a gap.
  assert.equal(escalated.meetingDemotedCategory, false);
  assert.equal(escalated.meetingDemotionReason, null);
  assert.equal(escalated.senderKindDemotedCategory, false);

  const gated = eventFor(
    applyFloors(classification({ category: "meeting" }), { ...floorContext(), ...recap }),
  );
  assert.equal(gated.meetingDemotedCategory, true);
  assert.equal(gated.meetingDemotionReason, "meeting_recap");
  assert.equal(gated.floorMatched, false);
  assert.equal(gated.finalCategory, "fyi");
});

test("senderExtractionEvent still reports every floor on the audit-less path", () => {
  // The fallback/default classification runs no floors at all. The record keeps
  // the same keys — an absent field and a floor that did not fire must not look
  // alike to the over-tag audits.
  const event = senderExtractionEvent({
    senderContextResult: senderContextResult(),
    observations: observations(),
    audit: null,
    classification: classification(),
    todoSuggested: false,
    standingSuppression: null,
    standingSuppressionReadFailed: false,
  });

  assert.deepEqual(
    {
      floorMatched: event.floorMatched,
      floorForced: event.floorForced,
      senderKindDemotedCategory: event.senderKindDemotedCategory,
      senderKindDemotionReason: event.senderKindDemotionReason,
      meetingDemotedCategory: event.meetingDemotedCategory,
      meetingDemotionReason: event.meetingDemotionReason,
    },
    {
      floorMatched: false,
      floorForced: false,
      senderKindDemotedCategory: false,
      senderKindDemotionReason: null,
      meetingDemotedCategory: false,
      meetingDemotionReason: null,
    },
  );
});

function floorContext(): FloorContext {
  return {
    signalText: "",
    collabVetoText: "",
    senderKind: null,
    effectiveAuthor: null,
    sender: null,
    subject: null,
    to: null,
    cc: null,
    accountEmail: null,
    contentFlags: { hasInvestorNotice: false, hasPublicEventLanguage: false },
  };
}

/** The trace the workflow would persist for a floor outcome. */
function eventFor(outcome: FloorOutcome) {
  return senderExtractionEvent({
    senderContextResult: senderContextResult(),
    observations: observations(),
    audit: {
      firstPass: classification({ category: "meeting" }),
      conflict: null,
      secondPass: null,
      secondPassFailure: null,
      floors: outcome.audits,
    },
    classification: outcome.classification,
    todoSuggested: false,
    standingSuppression: null,
    standingSuppressionReadFailed: false,
  });
}

function senderContextResult(): SenderContextResult {
  return {
    context: { fromKind: "person", effectiveAuthor: "person" },
    parserHit: null,
    senderAddress: "engineering@example.com",
    senderDomain: "example.com",
  };
}

function classification(overrides: Partial<TriageClassification> = {}): TriageClassification {
  return {
    category: "fyi",
    confidence: 0.8,
    rationale: "because",
    todoSuggestion: null,
    ...overrides,
  };
}

function observations(): Observations {
  return {
    senderPrior: { key: null, categoryCounts: {}, lastCategory: null },
    persona: null,
    thread: { lastUserReplyAt: null, newestDirection: null, messageCount: 0, recentMessages: [] },
    knownContact: false,
    senderRelationship: null,
    senderKind: {
      kind: "group",
      confidence: 0.99,
      evidenceCodes: ["gmail:list_id"],
      entityId: "ent_group",
      displayName: "Engineering",
    },
    gmail: { categories: [], important: false, starred: false, inInbox: true },
    content: {
      hasUnsubscribe: false,
      hasCurrencyAmount: false,
      hasSecurityKeyword: false,
      hasCalendarInvite: false,
      hasInvestorNotice: false,
      hasPublicEventLanguage: false,
    },
  };
}
