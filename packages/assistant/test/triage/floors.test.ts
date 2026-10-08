import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TriageClassification } from "@alfred/assistant/triage/classify";
import { applyFloors, type FloorContext } from "@alfred/assistant/triage/floors";
import { FLOOR_TRACE_PROJECTIONS } from "@alfred/assistant/triage/sender-extraction-event";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const groupKind = {
  kind: "group" as const,
  confidence: 0.99,
  evidenceCodes: ["gmail:list_id"],
  entityId: "ent_1",
  displayName: "Some List",
};

const serviceKind = {
  ...groupKind,
  kind: "service" as const,
  confidence: 0.92,
  evidenceCodes: ["email:local:service_strong"],
  displayName: "ClickUp",
};

function classification(over: Partial<TriageClassification> = {}): TriageClassification {
  return { category: "fyi", confidence: 0.8, rationale: "because", todoSuggestion: null, ...over };
}

function context(over: Partial<FloorContext> = {}): FloorContext {
  const signalText = over.signalText ?? "";

  return {
    signalText,
    collabVetoText: signalText,
    senderKind: null,
    effectiveAuthor: null,
    sender: null,
    subject: null,
    to: null,
    cc: null,
    accountEmail: null,
    contentFlags: { hasInvestorNotice: false, hasPublicEventLanguage: false },
    isSpam: false,
    ...over,
  } satisfies FloorContext;
}

const SECRET_TEXT = "an api key was leaked in the public repo";

// ---------------------------------------------------------------------------
// Floor order is the policy. Each case gives a different audit if the floors
// run in another order; the final category alone would not catch a swap.
// ---------------------------------------------------------------------------

describe("applyFloors — sequence order", () => {
  test("audits arrive in sequence order: override → senderKind → spam → meeting", () => {
    // One audit key per `FLOOR_SEQUENCE` entry, in fold order.
    const { audits } = applyFloors(classification(), context());
    assert.deepEqual(Object.keys(audits), ["override", "senderKind", "spam", "meeting"]);
  });

  test("every floor reports an audit even when none of them fire", () => {
    const outcome = applyFloors(classification({ category: "fyi" }), context());
    assert.equal(outcome.classification.category, "fyi");
    assert.deepEqual(outcome.audits.override, { verdict: { kind: "keep" }, matched: false });
    assert.deepEqual(outcome.audits.senderKind, { verdict: { kind: "keep" }, reason: null });
    assert.deepEqual(outcome.audits.spam, { verdict: { kind: "keep" }, outcome: null });
    assert.deepEqual(outcome.audits.meeting, { verdict: { kind: "keep" }, reason: null });
  });

  test("override runs FIRST: a secret escalation escapes the sender-kind demotion", () => {
    // Group sender + `awaiting_reply` always demotes, but sender-kind sees `urgent` first.
    // In reverse order, this input demotes to `fyi` and clears the todo.
    const outcome = applyFloors(
      classification({
        category: "awaiting_reply",
        todoSuggestion: { name: "Rotate the leaked key" },
        todoDecision: { outcome: "proposed" },
      }),
      context({ signalText: SECRET_TEXT, senderKind: groupKind }),
    );

    assert.equal(outcome.classification.category, "urgent");
    assert.equal(outcome.audits.override.verdict.kind, "escalate");
    assert.equal(outcome.audits.senderKind.verdict.kind, "keep");
    assert.deepEqual(outcome.classification.todoSuggestion, { name: "Rotate the leaked key" });
  });

  test("meeting runs LAST: a secret-escalated urgent is already past the gate", () => {
    // The meeting gate fires only on a surviving `meeting` tag; override already moved it.
    const outcome = applyFloors(
      classification({ category: "meeting" }),
      context({ signalText: SECRET_TEXT, subject: "Meeting notes: Eng standup" }),
    );

    assert.equal(outcome.classification.category, "urgent");
    assert.equal(outcome.audits.override.verdict.kind, "escalate");
    assert.equal(outcome.audits.meeting.verdict.kind, "keep");
    assert.equal(outcome.audits.meeting.reason, null);
  });

  test("meeting runs LAST: a sender-kind-demoted fyi is already past the gate", () => {
    // Sender-kind demotes first, so the meeting floor adds no second demotion reason.
    const outcome = applyFloors(
      classification({ category: "action_needed", collabActivity: "other_activity" }),
      context({
        signalText: "someone changed status on a task",
        senderKind: serviceKind,
        subject: "Meeting notes: Weekly sync",
      }),
    );

    assert.equal(outcome.classification.category, "fyi");
    assert.equal(outcome.audits.senderKind.verdict.kind, "demote");
    assert.equal(outcome.audits.senderKind.reason, "collab_passive_activity");
    assert.equal(outcome.audits.meeting.verdict.kind, "keep");
    assert.match(outcome.classification.todoDecision?.note ?? "", /^sender_kind_floor:/);
  });

  test("the meeting gate does fire on the same subject when it survives to it", () => {
    const outcome = applyFloors(
      classification({ category: "meeting" }),
      context({ subject: "Meeting notes: Eng standup", effectiveAuthor: "person" }),
    );

    assert.equal(outcome.classification.category, "fyi");
    assert.equal(outcome.audits.meeting.verdict.kind, "demote");
    assert.equal(outcome.audits.meeting.reason, "meeting_recap");
  });
});

// ---------------------------------------------------------------------------
// Each floor sees the previous floor's classification, not the model's.
// ---------------------------------------------------------------------------

describe("applyFloors — threading", () => {
  test("sender-kind is handed the override floor's urgent and keeps it under the secret veto", () => {
    // Only override escalates, and only on a leaked key, so the sign-in body names one.
    // The `matchesExposedSecret` veto (#580) then blocks the sign-in demotion.
    const body =
      "we detected a new sign-in to your account from a new device. " +
      "if this was you, no action is needed. " +
      "if you don't recognize this, your api key was leaked — rotate it now.";

    const outcome = applyFloors(
      classification({ category: "fyi" }),
      context({
        signalText: body,
        subject: "New sign-in to your account",
        senderKind: groupKind,
      }),
    );

    assert.equal(outcome.audits.override.verdict.kind, "escalate");
    assert.equal(outcome.audits.senderKind.verdict.kind, "keep");
    assert.equal(outcome.audits.senderKind.reason, null);
    assert.equal(outcome.classification.category, "urgent");
    // Only the override floor left its mark on the threaded classification.
    assert.match(outcome.classification.rationale, /Override floor:/);
    assert.doesNotMatch(outcome.classification.rationale, /Sender-kind floor:/);
  });

  test("the demotion veto survives a comma-set-off leak clause", () => {
    // Regression: #1188. The veto gap crosses one comma aside; the floor's gap does not,
    // so this body vetoes the demotion but does not force `urgent`.
    const body =
      "we detected a new sign-in to your account from a new device. " +
      "if this was you, no action is needed. " +
      "if you don't recognize this, your password, which unlocks the production " +
      "database, was found in a public dump.";

    const outcome = applyFloors(
      classification({ category: "action_needed" }),
      context({
        signalText: body,
        subject: "New sign-in to your account",
        senderKind: groupKind,
      }),
    );

    assert.equal(outcome.audits.override.verdict.kind, "keep");
    assert.equal(outcome.audits.senderKind.verdict.kind, "keep");
    assert.equal(outcome.classification.category, "action_needed");
  });

  test("is pure — the input classification is never mutated", () => {
    const input = classification({
      category: "meeting",
      todoSuggestion: { name: "Attend the standup" },
    });

    const before = structuredClone(input);
    const outcome = applyFloors(input, context({ subject: "Meeting notes: Eng standup" }));
    assert.deepEqual(input, before);
    assert.notEqual(outcome.classification, input);
  });
});

// ---------------------------------------------------------------------------
// The `model` tags. Each floor owns its tag, so the fold adds them, not `classifyEmail`.
// ---------------------------------------------------------------------------

describe("applyFloors — model id tags", () => {
  test("is empty when no floor fires", () => {
    assert.deepEqual(applyFloors(classification(), context()).modelIdTags, []);
  });

  test("tags only the floor that fired", () => {
    assert.deepEqual(
      applyFloors(classification({ category: "fyi" }), context({ signalText: SECRET_TEXT }))
        .modelIdTags,
      ["+floor"],
    );
    assert.deepEqual(
      applyFloors(
        classification({ category: "awaiting_reply" }),
        context({ senderKind: groupKind }),
      ).modelIdTags,
      ["+kindfloor"],
    );
    assert.deepEqual(
      applyFloors(
        classification({ category: "meeting" }),
        context({ subject: "Meeting notes: Eng standup", effectiveAuthor: "person" }),
      ).modelIdTags,
      ["+meetingfloor"],
    );
  });

  test("tags only the override floor on a sign-in broadcast that names a leaked key", () => {
    // Since #580, no demoting reason fires on `urgent` when `matchesExposedSecret` hits,
    // so `+kindfloor` is absent on purpose.
    const outcome = applyFloors(
      classification({ category: "fyi" }),
      context({
        signalText:
          "we detected a new sign-in to your account from a new device. " +
          "if this was you, no action is needed. " +
          "if you don't recognize this, your api key was leaked — rotate it now.",
        subject: "New sign-in to your account",
        senderKind: groupKind,
      }),
    );

    assert.deepEqual(outcome.modelIdTags, ["+floor"]);
  });
});

// ---------------------------------------------------------------------------
// The demotion convention, shared by every demoting floor.
// ---------------------------------------------------------------------------

describe("applyFloors — demote, never bury", () => {
  const cases: Array<{ name: string; classification: TriageClassification; ctx: FloorContext }> = [
    {
      name: "sender-kind",
      classification: classification({
        category: "awaiting_reply",
        todoSuggestion: { name: "Reply to the list" },
        todoDecision: { outcome: "proposed" },
      }),
      ctx: context({ senderKind: groupKind }),
    },
    {
      name: "meeting",
      classification: classification({
        category: "meeting",
        todoSuggestion: { name: "Attend the standup" },
        todoDecision: { outcome: "proposed" },
      }),
      ctx: context({ subject: "Meeting notes: Eng standup", effectiveAuthor: "person" }),
    },
  ];

  for (const c of cases) {
    test(`${c.name} floor demotes to fyi, clears the todo, and stamps the rationale`, () => {
      const { classification: out } = applyFloors(c.classification, c.ctx);
      assert.equal(out.category, "fyi");
      assert.equal(out.todoSuggestion, null);
      assert.equal(out.todoDecision?.outcome, "no_obligation");
      assert.match(out.todoDecision?.note ?? "", /_floor: /);
      assert.match(out.rationale, /— demoted \w+ → fyi \(demote, never bury\)\.$/);
    });
  }
});

// ---------------------------------------------------------------------------
// The persisted trace. `FLOOR_TRACE_PROJECTIONS` is keyed on the floor audits,
// so a new floor must name its facts in `agent_decision_traces`.
// This runtime check fails if someone widens that type instead.
// ---------------------------------------------------------------------------

describe("floors — trace projections", () => {
  test("every floor in the sequence projects onto the persisted trace", () => {
    const { audits } = applyFloors(classification(), context());
    assert.deepEqual(Object.keys(FLOOR_TRACE_PROJECTIONS).sort(), Object.keys(audits).sort());
  });
});
