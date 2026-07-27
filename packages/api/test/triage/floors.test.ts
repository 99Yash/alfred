import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TriageClassification } from "../../src/modules/triage/classify";
import { applyFloors, type FloorContext } from "../../src/modules/triage/floors";
import { FLOOR_TRACE_PROJECTIONS } from "../../src/modules/triage/sender-extraction-event";

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
    ...over,
  } satisfies FloorContext;
}

const SECRET_TEXT = "an api key was leaked in the public repo";

// ---------------------------------------------------------------------------
// The sequence itself: ORDER IS THE POLICY (floors/index.ts). Until this file
// existed, floor order was covered by exactly one end-to-end assertion in
// classify.test.ts — every other floor test called a single floor directly, so
// a reordered `FLOOR_SEQUENCE` was invisible. These cases are chosen so that
// running the same three floors in a different order gives a DIFFERENT audit;
// asserting the final category alone would not catch a swap.
// ---------------------------------------------------------------------------

describe("applyFloors — sequence order", () => {
  test("audits arrive in sequence order: override → senderKind → meeting", () => {
    // `applyFloors` inserts one audit key per `FLOOR_SEQUENCE` entry as it folds,
    // so key order IS sequence order.
    const { audits } = applyFloors(classification(), context());
    assert.deepEqual(Object.keys(audits), ["override", "senderKind", "meeting"]);
  });

  test("every floor reports an audit even when none of them fire", () => {
    const outcome = applyFloors(classification({ category: "fyi" }), context());
    assert.equal(outcome.classification.category, "fyi");
    assert.deepEqual(outcome.audits.override, { verdict: { kind: "keep" }, matched: false });
    assert.deepEqual(outcome.audits.senderKind, { verdict: { kind: "keep" }, reason: null });
    assert.deepEqual(outcome.audits.meeting, { verdict: { kind: "keep" }, reason: null });
  });

  test("override runs FIRST: a secret escalation escapes the sender-kind demotion", () => {
    // A group sender + `awaiting_reply` is the sender-kind floor's always-demote
    // case. Because the override floor escalates to `urgent` first, sender-kind
    // sees `urgent` — which it only demotes for a broadcast sign-in or a
    // monitoring alarm — so the security escalation and its todo both survive.
    // Reversed, this same input demotes to `fyi` and clears the todo.
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
    // Same recap subject the meeting floor demotes on its own (see below), but
    // the override floor has already moved the category off `meeting`, and the
    // meeting gate only fires on a surviving `meeting` tag.
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
    // Passive collab activity on a task tracker whose subject also reads as a
    // recap. Sender-kind demotes it, so the meeting floor stamps nothing — one
    // demotion, one rationale clause, one reason in the audit.
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
// Threading: each floor sees the PREVIOUS floor's classification, not the
// model's. This is the property the fold exists to make structural.
// ---------------------------------------------------------------------------

describe("applyFloors — threading", () => {
  test("sender-kind demotes the category the override floor forced, not the model's", () => {
    // The model said `fyi`, which the sender-kind floor never demotes. It
    // demotes here only because it is handed the override floor's `urgent`.
    //
    // The fixture is a sign-in broadcast that ALSO names a leaked key, because
    // the override floor is the only floor that escalates and it fires on
    // nothing else — so this is the only shape that can prove the threading.
    // The final `fyi` it asserts is a PREEXISTING veto asymmetry, not a
    // judgment that a leaked-secret mail belongs in `fyi`: the
    // `collab_passive_activity` and `monitoring_alarm` reasons both refuse to
    // demote when `matchesExposedSecret` hits; `broadcast_auth_signin_confirmation`
    // does not. Closing that gap should flip THIS assertion, not delete the test.
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
    assert.equal(outcome.audits.senderKind.verdict.kind, "demote");
    assert.equal(outcome.audits.senderKind.reason, "broadcast_auth_signin_confirmation");
    assert.equal(outcome.classification.category, "fyi");
    // Both floors left their mark on the one threaded classification.
    assert.match(outcome.classification.rationale, /Override floor:/);
    assert.match(outcome.classification.rationale, /Sender-kind floor:/);
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
// The `model` tags. Each floor registers its own next to its `apply`, so the
// fold — not `classifyEmail` — is what contributes them to the model id.
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

  test("arrive in sequence order when two floors fire on one email", () => {
    // Same sign-in-plus-leaked-key body as the threading case above, and for the
    // same reason: only the override floor escalates, so two floors can only fire
    // on one email through it. See that test for the veto asymmetry it rides on.
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
    assert.deepEqual(outcome.modelIdTags, ["+floor", "+kindfloor"]);
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
// The persisted trace. `FLOOR_TRACE_PROJECTIONS` is keyed on the audits this
// sequence derives, so a fourth floor cannot compile until it says what its
// facts are CALLED in `agent_decision_traces` — the one floor consumer the
// over-tag audits (#210/#354) can query. This is the runtime twin of that
// compile error: it fails if the annotation is widened rather than answered.
// ---------------------------------------------------------------------------

describe("floors — trace projections", () => {
  test("every floor in the sequence projects onto the persisted trace", () => {
    const { audits } = applyFloors(classification(), context());
    assert.deepEqual(Object.keys(FLOOR_TRACE_PROJECTIONS).sort(), Object.keys(audits).sort());
  });
});
