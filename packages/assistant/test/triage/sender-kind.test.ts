import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ActiveEntityProfile } from "@alfred/assistant/knowledge";
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
