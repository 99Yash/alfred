import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ActiveEntityProfile } from "@alfred/assistant/knowledge";
import type { TriageClassification } from "@alfred/assistant/triage/classify";
import { applyFloors, type FloorOutcome } from "@alfred/assistant/triage/floors";
import type { Observations } from "@alfred/assistant/triage/observations";
import type { SenderContextResult } from "@alfred/assistant/knowledge/sender-context";
import { senderExtractionEvent } from "../../src/triage/sender-extraction-event";
import { senderKindSignalFromProfile } from "../../src/triage/sender-kind";

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

test("senderExtractionEvent records the sender-kind projection breadcrumb", () => {
  const event = senderExtractionEvent({
    senderContextResult: senderContextResult(),
    observations: observations(),
    audit: {
      firstPass: classification({ category: "action", collabActivity: "other_activity" }),
      conflict: null,
      secondPass: null,
      secondPassFailure: null,
      floors: {
        override: { verdict: { kind: "keep" }, matched: false },
      },
    },
    classification: classification({ collabActivity: "other_activity" }),
    todoSuggested: false,
    standingSuppression: { kind: "none" },
  });

  assert.equal(event.senderKind, "group");
  assert.equal(event.senderKindConfidence, 0.99);
  assert.deepEqual(event.senderKindEvidenceCodes, ["gmail:list_id"]);
  assert.equal(event.senderKindDemotedPersonTreatment, true);
  assert.equal(event.firstPassCollabActivity, "other_activity");
  assert.equal(event.finalCollabActivity, "other_activity");
  assert.equal(event.knownContact, false);
  assert.equal(event.senderRelationship, null);
});

test("senderExtractionEvent carries the override floor's real outcome", () => {
  // Use the fold's real output, not a hand-built audit, so the test crosses the projection seam.
  const escalated = eventFor(
    applyFloors(classification({ category: "fyi" }), {
      signalText: "an api key was leaked in the public repo",
    }),
  );

  assert.equal(escalated.floorMatched, true);
  assert.equal(escalated.floorForced, true);
  assert.equal(escalated.finalCategory, "urgent");
});

test("senderExtractionEvent still reports every floor on the audit-less path", () => {
  // The fallback runs no floors but keeps the same keys. Audits must tell "absent" from "did not fire".
  const event = senderExtractionEvent({
    senderContextResult: senderContextResult(),
    observations: observations(),
    audit: null,
    classification: classification(),
    todoSuggested: false,
    standingSuppression: { kind: "none" },
  });

  assert.deepEqual(
    {
      floorMatched: event.floorMatched,
      floorForced: event.floorForced,
    },
    {
      floorMatched: false,
      floorForced: false,
    },
  );
});

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
    standingSuppression: { kind: "none" },
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
    gmail: {
      categories: [],
      important: false,
      starred: false,
      inInbox: true,
      spam: false,
      trash: false,
    },
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
