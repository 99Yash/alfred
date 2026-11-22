import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TriageClassification } from "@alfred/assistant/triage/classify";
import { applyFloors, type FloorContext } from "@alfred/assistant/triage/floors";
import { FLOOR_TRACE_PROJECTIONS } from "@alfred/assistant/triage/sender-extraction-event";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function classification(over: Partial<TriageClassification> = {}): TriageClassification {
  return { category: "fyi", confidence: 0.8, rationale: "because", todoSuggestion: null, ...over };
}

function context(over: Partial<FloorContext> = {}): FloorContext {
  return { signalText: over.signalText ?? "", ...over } satisfies FloorContext;
}

const SECRET_TEXT = "an api key was leaked in the public repo";

// ---------------------------------------------------------------------------
// The sequence. The override floor is the only system floor left (slice 3): the
// sender-kind and meeting demotions are the model's judgment now.
// ---------------------------------------------------------------------------

describe("applyFloors — sequence order", () => {
  test("the one floor is override", () => {
    // One audit key per `FLOOR_SEQUENCE` entry, in fold order.
    const { audits } = applyFloors(classification(), context());
    assert.deepEqual(Object.keys(audits), ["override"]);
  });

  test("every floor reports an audit even when none of them fire", () => {
    const outcome = applyFloors(classification({ category: "fyi" }), context());
    assert.equal(outcome.classification.category, "fyi");
    assert.deepEqual(outcome.audits.override, { verdict: { kind: "keep" }, matched: false });
  });

  test("a leaked secret escalates fyi to urgent", () => {
    const outcome = applyFloors(
      classification({ category: "fyi" }),
      context({ signalText: SECRET_TEXT }),
    );

    assert.equal(outcome.classification.category, "urgent");
    assert.equal(outcome.audits.override.verdict.kind, "escalate");
  });

  test("a demand lane that does not name a leak keeps its category", () => {
    // Regression: #1188. The veto gap crosses one comma aside; the floor's gap does not,
    // so this body neither escalates nor demotes.
    const body =
      "we detected a new sign-in to your account from a new device. " +
      "if this was you, no action is needed. " +
      "if you don't recognize this, your password, which unlocks the production " +
      "database, was found in a public dump.";

    const outcome = applyFloors(
      classification({ category: "action" }),
      context({ signalText: body }),
    );

    assert.equal(outcome.audits.override.verdict.kind, "keep");
    assert.equal(outcome.classification.category, "action");
  });

  test("is pure — the input classification is never mutated", () => {
    const input = classification({
      category: "meeting",
      todoSuggestion: { name: "Attend the standup" },
    });

    const before = structuredClone(input);
    applyFloors(input, context());
    assert.deepEqual(input, before);
  });
});

// ---------------------------------------------------------------------------
// The `model` tags. Each floor owns its tag, so the fold adds them, not `classifyEmail`.
// ---------------------------------------------------------------------------

describe("applyFloors — model id tags", () => {
  test("is empty when no floor fires", () => {
    assert.deepEqual(applyFloors(classification(), context()).modelIdTags, []);
  });

  test("tags the override floor when it fires", () => {
    assert.deepEqual(
      applyFloors(classification({ category: "fyi" }), context({ signalText: SECRET_TEXT }))
        .modelIdTags,
      ["+floor"],
    );
  });

  test("tags only the override floor on a sign-in broadcast that names a leaked key", () => {
    const outcome = applyFloors(
      classification({ category: "fyi" }),
      context({
        signalText:
          "we detected a new sign-in to your account from a new device. " +
          "if this was you, no action is needed. " +
          "if you don't recognize this, your api key was leaked — rotate it now.",
      }),
    );

    assert.deepEqual(outcome.modelIdTags, ["+floor"]);
  });
});

// ---------------------------------------------------------------------------
// The persisted trace. `FLOOR_TRACE_PROJECTIONS` is keyed on the floor audits,
// so a new floor must name its facts in `agent_decision_traces`.
// This runtime check fails if someone widens that type instead.
// ---------------------------------------------------------------------------

describe("floors — trace projections", () => {
  test("every floor in the sequence projects onto the persisted trace", () => {
    const { audits } = applyFloors(classification(), context());
    assert.deepEqual(
      Object.keys(FLOOR_TRACE_PROJECTIONS).toSorted(),
      Object.keys(audits).toSorted(),
    );
  });
});
