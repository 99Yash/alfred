import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ActiveEntityProfile } from "../../src/modules/user-model";
import { senderExtractionEvent, senderKindSignalFromProfile } from "../../src/modules/triage";
import type { TriageClassification } from "../../src/modules/triage/classify";
import type { Observations } from "../../src/modules/triage/observations";
import type { SenderContextResult } from "../../src/modules/triage/sender-context";

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
    audit: null,
    classification: classification(),
    todoSuggested: false,
    standingSuppression: null,
    standingSuppressionReadFailed: false,
  });

  assert.equal(event.senderKind, "group");
  assert.equal(event.senderKindConfidence, 0.99);
  assert.deepEqual(event.senderKindEvidenceCodes, ["gmail:list_id"]);
  assert.equal(event.senderKindDemotedPersonTreatment, true);
  assert.equal(event.knownContact, false);
  assert.equal(event.senderRelationship, null);
});

function senderContextResult(): SenderContextResult {
  return {
    context: { fromKind: "person", effectiveAuthor: "person" },
    parserHit: null,
    senderAddress: "engineering@example.com",
    senderDomain: "example.com",
  };
}

function classification(): TriageClassification {
  return { category: "fyi", confidence: 0.8, rationale: "because", todoSuggestion: null };
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
