import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TriageClassification } from "@alfred/assistant/triage/classify";
import {
  applyFloors,
  applyStandingInstructionEffects,
  type FloorContext,
  type StandingInstructionMatch,
} from "@alfred/assistant/triage/floors";
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

/** A v1 row as the reader lifts it: one sender target, `demote_demand`, and the todo block. */
function v1TargetMatch(): StandingInstructionMatch {
  return {
    factId: "fact_ricktyy6c1gc",
    validFrom: new Date("2026-09-01T00:00:00Z"),
    value: {
      schemaVersion: 2,
      instructionId: "fact_ricktyy6c1gc",
      revision: 0,
      phrasing: "stop reminding me about connecting stuff to polylane",
      directive: "Treat routine notices as FYI, not urgent.",
      targets: [{ kind: "sender_domain", domain: "polylane.dev", accountId: null }],
      effects: [{ kind: "demote_demand" }, { kind: "block_todo_suggestion" }],
    },
    via: { kind: "target", targetKind: "sender_domain" },
  };
}

function verdictOf(c: TriageClassification) {
  return {
    category: c.category,
    documentAsk: c.documentAsk ?? null,
    todoSuggestion: c.todoSuggestion ?? null,
    todoDecision: c.todoDecision ?? null,
  };
}

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

  test("the instruction floor demotes the model's demand lane on a v1 target hit", () => {
    // Exactly the Polylane shape: the model chose action for a connect
    // upsell, the user's own words for this sender say otherwise (ADR-0110, ADR-0113).
    const { result, audit, reason } = applyStandingInstructionEffects(
      verdictOf(
        classification({
          category: "action",
          todoSuggestion: { name: "Connect Supabase to Polylane" },
          todoDecision: { outcome: "proposed" },
        }),
      ),
      { exposedSecret: false, matches: [v1TargetMatch()] },
    );

    assert.equal(result.category, "fyi");
    assert.equal(audit.outcome, "demoted_demand_lane");
    // A demoted lane no longer proposes anything.
    assert.equal(result.todoSuggestion, null);
    assert.equal(result.todoDecision?.outcome, "no_obligation");
    assert.match(result.todoDecision.note ?? "", /^standing_floor: .*fact_ricktyy6c1gc/);
    assert.match(reason ?? "", /fact_ricktyy6c1gc/);
  });

  test("the instruction floor holds the lane behind the exposed-secret signal", () => {
    // ADR-0106's bar, kept: the protective security floor outranks a down-rank,
    // so a leaked secret on a suppressed sender stays urgent.
    const outcome = applyFloors(
      classification({ category: "action" }),
      context({ signalText: SECRET_TEXT }),
    );

    const { result, audit } = applyStandingInstructionEffects(verdictOf(outcome.classification), {
      exposedSecret: true,
      matches: [v1TargetMatch()],
    });

    assert.equal(outcome.audits.override.verdict.kind, "escalate");
    assert.equal(result.category, "urgent");
    assert.equal(audit.outcome, "held_secret_lane");
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
