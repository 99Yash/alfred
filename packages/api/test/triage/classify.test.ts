import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyOverrideFloor,
  classifyEmail,
  detectConflict,
  resolveTodoSuggestion,
  triageClassificationSchema,
  type ClassifyEmailArgs,
  type RunPass,
  type TriageClassification,
} from "../../src/modules/triage/classify";
import type { Observations } from "../../src/modules/triage/observations";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function observations(overrides: Partial<Observations> = {}): Observations {
  return {
    senderPrior: { key: null, categoryCounts: {}, lastCategory: null },
    persona: null,
    thread: { lastUserReplyAt: null, newestDirection: null, messageCount: 0 },
    knownContact: false,
    gmail: { categories: [], important: false, starred: false, inInbox: true },
    content: {
      hasUnsubscribe: false,
      hasCurrencyAmount: false,
      hasSecurityKeyword: false,
      hasCalendarInvite: false,
      hasInvestorNotice: false,
      hasPublicEventLanguage: false,
    },
    ...overrides,
  };
}

function classification(over: Partial<TriageClassification> = {}): TriageClassification {
  return { category: "fyi", confidence: 0.8, rationale: "because", todoSuggestion: null, ...over };
}

function args(over: Partial<ClassifyEmailArgs> = {}): ClassifyEmailArgs {
  return {
    document: { id: "doc_1", title: "Subject", content: "Body", authoredAt: null, metadata: {} },
    senderContext: { fromKind: "service", effectiveAuthor: "service" },
    observations: observations(),
    ...over,
  };
}

/** A canned model that returns a fixed output per pass, recording call count. */
function scriptedModel(first: TriageClassification, second?: TriageClassification) {
  let calls = 0;
  const runPass: RunPass = async ({ pass }) => {
    calls++;
    return pass === "second" && second ? second : first;
  };
  return { runPass, calls: () => calls };
}

// ---------------------------------------------------------------------------
// applyOverrideFloor
// ---------------------------------------------------------------------------

describe("applyOverrideFloor", () => {
  test("forces urgent on an exposed-secret body regardless of model output", () => {
    const r = applyOverrideFloor(
      classification({ category: "newsletter" }),
      "a private api key was leaked in this commit and must be rotated",
    );
    assert.equal(r.classification.category, "urgent");
    assert.equal(r.forced, true);
    assert.match(r.classification.rationale, /override floor/i);
  });

  test("does NOT trip on a self-initiated magic link (auth vocab, no exposure verb)", () => {
    const r = applyOverrideFloor(
      classification({ category: "action_needed" }),
      "sign in to anthropic — your login code is 123456. verify your email address.",
    );
    assert.equal(r.classification.category, "action_needed");
    assert.equal(r.forced, false);
  });

  test("does not double-force when the model already said urgent", () => {
    const c = classification({ category: "urgent" });
    const r = applyOverrideFloor(c, "secret token exposed");
    assert.equal(r.forced, false);
    assert.deepEqual(r.classification, c);
  });

  test("does NOT trip on generic 'credential ... exposed' engineering prose", () => {
    // `credential` is excluded from the unrecoverable floor (it stays in the
    // broad hint regex) so architecture discussion doesn't get force-tagged.
    const r = applyOverrideFloor(
      classification({ category: "fyi" }),
      "the credential object is exposed to the network in this design",
    );
    assert.equal(r.forced, false);
    assert.equal(r.classification.category, "fyi");
  });

  test("ignores a bare CVE id (CVE is the model's call, not the floor's)", () => {
    const r = applyOverrideFloor(
      classification({ category: "fyi" }),
      "dependabot alert: cve-2024-1234 in lodash (moderate)",
    );
    assert.equal(r.forced, false);
    assert.equal(r.classification.category, "fyi");
  });
});

// ---------------------------------------------------------------------------
// detectConflict
// ---------------------------------------------------------------------------

describe("detectConflict", () => {
  test("under-classification: security flag + passive category, floor not firing", () => {
    const conflict = detectConflict(
      classification({ category: "fyi" }),
      observations({ content: { ...observations().content, hasSecurityKeyword: true } }),
      false,
    );
    assert.equal(conflict?.kind, "under_classification");
  });

  test("no under-classification when the floor will already force urgent", () => {
    const conflict = detectConflict(
      classification({ category: "fyi" }),
      observations({ content: { ...observations().content, hasSecurityKeyword: true } }),
      true,
    );
    assert.equal(conflict, null);
  });

  test("over-classification: important category from a strong-bulk sender, no support", () => {
    const conflict = detectConflict(
      classification({ category: "urgent" }),
      observations({
        senderPrior: {
          key: "news@x.com",
          categoryCounts: { newsletter: 9, marketing: 1 },
          lastCategory: "newsletter",
        },
      }),
      false,
    );
    assert.equal(conflict?.kind, "over_classification");
  });

  test("no over-classification when Gmail marked the message IMPORTANT", () => {
    const conflict = detectConflict(
      classification({ category: "urgent" }),
      observations({
        senderPrior: {
          key: "news@x.com",
          categoryCounts: { newsletter: 9, marketing: 1 },
          lastCategory: "newsletter",
        },
        gmail: { categories: [], important: true, starred: false, inInbox: true },
      }),
      false,
    );
    assert.equal(conflict, null);
  });

  test("no over-classification when the bulk share or volume is too low", () => {
    // share 0.6 < 0.8
    assert.equal(
      detectConflict(
        classification({ category: "urgent" }),
        observations({
          senderPrior: {
            key: "x",
            categoryCounts: { newsletter: 3, payment: 2 },
            lastCategory: "newsletter",
          },
        }),
        false,
      ),
      null,
    );
    // total 4 < 5
    assert.equal(
      detectConflict(
        classification({ category: "urgent" }),
        observations({
          senderPrior: { key: "x", categoryCounts: { newsletter: 4 }, lastCategory: "newsletter" },
        }),
        false,
      ),
      null,
    );
  });

  test("no conflict for an ordinary passive classification with no signals", () => {
    assert.equal(detectConflict(classification({ category: "fyi" }), observations(), false), null);
  });
});

// ---------------------------------------------------------------------------
// classifyEmail orchestration (injected model seam — no live LLM)
// ---------------------------------------------------------------------------

describe("classifyEmail", () => {
  test("acceptance: prior-heavy newsletter sender + credential-exposure body still lands urgent", async () => {
    // The model under-classifies (newsletter), but the body exposes a secret —
    // the override floor forces urgent.
    const model = scriptedModel(classification({ category: "newsletter", confidence: 0.95 }));
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_secret",
          title: "Weekly digest",
          content: "...also your private api key was leaked in our config repo, rotate it now",
          authoredAt: null,
          metadata: {},
        },
        observations: observations({
          senderPrior: {
            key: "news@x.com",
            categoryCounts: { newsletter: 40 },
            lastCategory: "newsletter",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "urgent");
    assert.equal(result.audit.floorForced, true);
    assert.match(result.model, /\+floor$/);
  });

  test("acceptance: self-initiated magic link stays action_needed (floor never trips)", async () => {
    const model = scriptedModel(classification({ category: "action_needed", confidence: 0.9 }));
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_magic",
          title: "Sign in to Anthropic",
          content: "Click to sign in. Your login code is 123456. Verify your email address.",
          authoredAt: null,
          metadata: {},
        },
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "action_needed");
    assert.equal(result.audit.floorForced, false);
    assert.equal(result.audit.conflict, null);
    assert.equal(model.calls(), 1); // no second pass
  });

  test("acceptance: a hard conflict triggers at most one second pass", async () => {
    // First pass under-classifies a security body as fyi; conflict fires; the
    // second pass corrects to action_needed and is final. Exactly two calls.
    const model = scriptedModel(
      classification({ category: "fyi" }),
      classification({ category: "action_needed", confidence: 0.7 }),
    );
    const result = await classifyEmail(
      args({
        observations: observations({
          content: { ...observations().content, hasSecurityKeyword: true },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(model.calls(), 2);
    assert.equal(result.audit.conflict?.kind, "under_classification");
    assert.equal(result.audit.secondPass?.category, "action_needed");
    assert.equal(result.classification.category, "action_needed");
    assert.match(result.model, /\+2pass$/);
  });

  test("no conflict → single pass, audit reflects no second pass or floor", async () => {
    const model = scriptedModel(classification({ category: "newsletter" }));
    const result = await classifyEmail(
      args({
        observations: observations({
          content: { ...observations().content, hasUnsubscribe: true },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(model.calls(), 1);
    assert.equal(result.audit.conflict, null);
    assert.equal(result.audit.secondPass, null);
    assert.equal(result.audit.floorForced, false);
    assert.equal(result.classification.category, "newsletter");
    assert.equal(result.model, "injected");
  });

  test("todoSuggestion rides the final classification through the floor", async () => {
    const model = scriptedModel(
      classification({ category: "action_needed", todoSuggestion: { name: "Rotate the key" } }),
    );
    const result = await classifyEmail(args({ runPass: model.runPass }));
    assert.deepEqual(result.classification.todoSuggestion, { name: "Rotate the key" });
  });
});

// ---------------------------------------------------------------------------
// Phase 0 — shipped todo contract (ADR-0050 amendment): schema shape + gate.
// Locks behavior the v3 classifier rewrite must preserve. The cheap model emits
// `todoSuggestion`; the workflow tail step mints a `suggested` todo ONLY through
// `resolveTodoSuggestion`, which is the single decision point for the rail.
// ---------------------------------------------------------------------------

describe("triageClassificationSchema.todoSuggestion", () => {
  function parseTodo(todoSuggestion: unknown) {
    return triageClassificationSchema.safeParse({
      category: "action_needed",
      confidence: 0.8,
      rationale: "x",
      todoSuggestion,
    });
  }

  test("accepts null", () => {
    assert.equal(parseTodo(null).success, true);
  });

  test("accepts { name } with no assist", () => {
    const r = parseTodo({ name: "Reply to Priya about the Q3 budget" });
    assert.equal(r.success, true);
  });

  test("accepts { name, assist }", () => {
    const r = parseTodo({ name: "Rotate the exposed Redis credential", assist: "before EOD" });
    assert.equal(r.success, true);
  });

  test("accepts a missing key (optional on the type for non-cheap producers)", () => {
    const r = triageClassificationSchema.safeParse({
      category: "fyi",
      confidence: 0.9,
      rationale: "x",
    });
    assert.equal(r.success, true);
  });

  test("rejects an empty name", () => {
    assert.equal(parseTodo({ name: "" }).success, false);
  });

  test("rejects a name past the 120-char cap", () => {
    assert.equal(parseTodo({ name: "x".repeat(121) }).success, false);
  });

  test("rejects an assist past the 280-char cap", () => {
    assert.equal(parseTodo({ name: "Do the thing", assist: "y".repeat(281) }).success, false);
  });
});

describe("resolveTodoSuggestion", () => {
  const suggestion = { name: "Reply to Priya about the Q3 budget", assist: "she needs it Friday" };

  test("acceptance: an action_needed message with a concrete ask passes the suggestion through", () => {
    const resolved = resolveTodoSuggestion(
      classification({ category: "action_needed", todoSuggestion: suggestion }),
    );
    assert.deepEqual(resolved, suggestion);
  });

  test("urgent with a concrete ask passes through", () => {
    assert.deepEqual(
      resolveTodoSuggestion(
        classification({ category: "urgent", todoSuggestion: { name: "Rotate the Redis key" } }),
      ),
      { name: "Rotate the Redis key" },
    );
  });

  for (const category of ["marketing", "newsletter", "fyi", "done"] as const) {
    test(`acceptance: ${category} suppresses a stray suggestion the model emitted anyway`, () => {
      assert.equal(
        resolveTodoSuggestion(classification({ category, todoSuggestion: suggestion })),
        null,
      );
    });
  }

  test("null when the model proposed no todo (eligible category)", () => {
    assert.equal(
      resolveTodoSuggestion(classification({ category: "action_needed", todoSuggestion: null })),
      null,
    );
  });

  test("null when todoSuggestion is absent (non-cheap producer)", () => {
    const c: TriageClassification = { category: "action_needed", confidence: 0.7, rationale: "x" };
    assert.equal(resolveTodoSuggestion(c), null);
  });
});
