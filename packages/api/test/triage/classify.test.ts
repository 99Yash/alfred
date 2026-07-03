import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyOverrideFloor,
  applySenderKindDemotionFloor,
  classifyEmail,
  detectConflict,
  resolveTodoSuggestion,
  sanitizeAssist,
  sanitizeTodoName,
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
    thread: { lastUserReplyAt: null, newestDirection: null, messageCount: 0, recentMessages: [] },
    knownContact: false,
    senderRelationship: null,
    senderKind: null,
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
      classification({ category: "newsletter", confidence: 0.8 }),
      "a private api key was leaked in this commit and must be rotated",
    );
    assert.equal(r.classification.category, "urgent");
    assert.equal(r.forced, true);
    assert.match(r.classification.rationale, /override floor/i);
    // Forced urgent floors confidence to 0.85 (it is surfaced in the UI).
    assert.equal(r.classification.confidence, 0.85);
  });

  test("preserves a model confidence already above the 0.85 floor (Math.max, not overwrite)", () => {
    const r = applyOverrideFloor(
      classification({ category: "fyi", confidence: 0.97 }),
      "secret api key was exposed",
    );
    assert.equal(r.classification.category, "urgent");
    assert.equal(r.classification.confidence, 0.97);
  });

  test("does NOT trip on a self-initiated magic link (auth vocab, no exposure verb)", () => {
    const r = applyOverrideFloor(
      classification({ category: "fyi" }),
      "sign in to anthropic — your login code is 123456. verify your email address.",
    );
    assert.equal(r.classification.category, "fyi");
    assert.equal(r.forced, false);
  });

  test("does not double-force when the model already said urgent", () => {
    const c = classification({ category: "urgent" });
    const r = applyOverrideFloor(c, "secret token exposed");
    assert.equal(r.matched, true);
    assert.equal(r.forced, false);
    assert.deepEqual(r.classification, c);
  });

  test("trips on found/detected secret-alert wording in either order", () => {
    const cases = [
      "GitHub detected a secret in this repository",
      "we found an API key in your repo",
      "token found in repository history",
      "a private key was detected by secret scanning",
    ];
    for (const text of cases) {
      const r = applyOverrideFloor(classification({ category: "fyi" }), text);
      assert.equal(r.matched, true, text);
      assert.equal(r.forced, true, text);
      assert.equal(r.classification.category, "urgent", text);
    }
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
// applySenderKindDemotionFloor
// ---------------------------------------------------------------------------

describe("applySenderKindDemotionFloor", () => {
  const groupKind = {
    kind: "group" as const,
    confidence: 0.99,
    evidenceCodes: ["gmail:list_id"],
    entityId: "ent_1",
    displayName: "Some List",
  };
  const serviceKind = { ...groupKind, kind: "service" as const, confidence: 0.92 };

  test("demotes awaiting_reply → fyi for a confident group sender (never buries)", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "awaiting_reply", confidence: 0.9 }),
      groupKind,
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
    assert.match(r.classification.rationale, /sender-kind floor/i);
  });

  test("demotes awaiting_reply → fyi for a confident service sender too", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "awaiting_reply" }),
      serviceKind,
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("leaves action_needed untouched — a group/service CAN assign a real action (ADR-0066)", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("leaves urgent untouched (out of this narrow floor's scope)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind);
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("no-op when senderKind is null (silent graph = no demotion)", () => {
    const c = classification({ category: "awaiting_reply" });
    const r = applySenderKindDemotionFloor(c, null);
    assert.equal(r.demoted, false);
    assert.deepEqual(r.classification, c);
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

  test("over-classification A: a bulk sender's security-topic MENTION is still challenged when the floor is silent (the 'stop storing your api keys' newsletter miss)", () => {
    const conflict = detectConflict(
      classification({ category: "urgent" }),
      observations({
        senderPrior: {
          key: "newsletter@devdigest.io",
          categoryCounts: { newsletter: 8, marketing: 2 },
          lastCategory: "newsletter",
        },
        // hasSecurityKeyword used to DISABLE this net — now it's gated on the
        // floor instead, so an educational security mention still gets re-asked.
        content: { ...observations().content, hasSecurityKeyword: true },
      }),
      false, // floor did NOT match — the subject has no exposure verb
    );
    assert.equal(conflict?.kind, "over_classification");
  });

  test("no over-classification A when the floor WILL force urgent (a real exposed secret from a bulk sender)", () => {
    const conflict = detectConflict(
      classification({ category: "urgent" }),
      observations({
        senderPrior: {
          key: "newsletter@devdigest.io",
          categoryCounts: { newsletter: 9, marketing: 1 },
          lastCategory: "newsletter",
        },
        content: { ...observations().content, hasSecurityKeyword: true },
      }),
      true, // floor matched → don't challenge; the floor forces urgent regardless
    );
    assert.equal(conflict, null);
  });

  test("over-classification B: a service sender's action_needed spike is challenged against a self-reinforcing prior (#351)", () => {
    const conflict = detectConflict(
      classification({ category: "action_needed" }),
      observations({
        senderPrior: {
          key: "service:tasks.clickup.com",
          categoryCounts: { action_needed: 8, fyi: 3, done: 1 },
          lastCategory: "action_needed",
        },
      }),
      false,
    );
    assert.equal(conflict?.kind, "over_classification");
  });

  test("over-classification B also fires via senderKind=service (an unrecognized service address)", () => {
    const conflict = detectConflict(
      classification({ category: "action_needed" }),
      observations({
        senderPrior: {
          key: "notifications@sometracker.com",
          categoryCounts: { action_needed: 10, fyi: 2 },
          lastCategory: "action_needed",
        },
        senderKind: {
          kind: "service",
          confidence: 0.9,
          evidenceCodes: [],
          entityId: "ent_tracker",
          displayName: "SomeTracker",
        },
      }),
      false,
    );
    assert.equal(conflict?.kind, "over_classification");
  });

  test("over-classification B fires for a production-shaped service sender key via SenderContext", () => {
    const conflict = detectConflict(
      classification({ category: "action_needed" }),
      observations({
        senderPrior: {
          key: "notifications@tasks.clickup.com",
          categoryCounts: { action_needed: 10, fyi: 2 },
          lastCategory: "action_needed",
        },
      }),
      false,
      { effectiveAuthor: "service" },
    );
    assert.equal(conflict?.kind, "over_classification");
  });

  test("no over-classification B for a low-volume service prior (the loop is not yet established)", () => {
    assert.equal(
      detectConflict(
        classification({ category: "action_needed" }),
        observations({
          senderPrior: {
            key: "service:tasks.clickup.com",
            categoryCounts: { action_needed: 3, fyi: 1 },
            lastCategory: "action_needed",
          },
        }),
        false,
      ),
      null,
    );
  });

  test("no over-classification B for a non-service (person) sender, even with an action_needed-heavy prior", () => {
    // A real person's direct ask must never be challenged by the service net —
    // the ~genuine assignment notifications #351 flags as correct are preserved.
    assert.equal(
      detectConflict(
        classification({ category: "action_needed" }),
        observations({
          senderPrior: {
            key: "colleague@work.com",
            categoryCounts: { action_needed: 9, fyi: 1 },
            lastCategory: "action_needed",
          },
        }),
        false,
        { effectiveAuthor: "person" },
      ),
      null,
    );
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

  test("acceptance: self-initiated magic link is fyi, single pass (rule 15)", async () => {
    // Clean auth text trips neither the override floor (no exposure verb) nor the
    // under-classification net (no security keyword), so fyi — a passive category —
    // survives without a second pass.
    const model = scriptedModel(classification({ category: "fyi", confidence: 0.9 }));
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
    assert.equal(result.classification.category, "fyi");
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
    assert.equal(result.audit.secondPassFailure, null);
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
    assert.equal(result.audit.secondPassFailure, null);
    assert.equal(result.audit.floorMatched, false);
    assert.equal(result.audit.floorForced, false);
    assert.equal(result.classification.category, "newsletter");
    assert.equal(result.model, "injected");
  });

  test("sender-kind floor demotes awaiting_reply → fyi end-to-end and tags +kindfloor", async () => {
    const model = scriptedModel(classification({ category: "awaiting_reply", confidence: 0.9 }));
    const result = await classifyEmail(
      args({
        observations: observations({
          senderKind: {
            kind: "group",
            confidence: 0.99,
            evidenceCodes: ["gmail:list_id"],
            entityId: "ent_1",
            displayName: "LinkedIn",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.senderKindDemoted, true);
    assert.equal(result.audit.firstPass.category, "awaiting_reply");
    assert.equal(result.model, "injected+kindfloor");
  });

  test("todoSuggestion rides the final classification through the floor", async () => {
    const model = scriptedModel(
      classification({
        category: "action_needed",
        todoSuggestion: { name: "Rotate the key" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(args({ runPass: model.runPass }));
    assert.deepEqual(result.classification.todoSuggestion, { name: "Rotate the key" });
  });

  test("todoSuggestion survives when the floor FORCES the category to urgent", async () => {
    // The documented invariant the tail step relies on (email-triage.ts): the
    // override floor changes the category but must preserve todoSuggestion, and
    // resolveTodoSuggestion runs on the POST-floor classification.
    const model = scriptedModel(
      classification({
        category: "action_needed",
        confidence: 0.6,
        todoSuggestion: { name: "Rotate the leaked Redis key" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_floor_todo",
          title: "heads up",
          content: "your private api key was leaked in the config repo",
          authoredAt: null,
          metadata: {},
        },
        runPass: model.runPass,
      }),
    );
    assert.equal(result.audit.floorForced, true);
    assert.equal(result.classification.category, "urgent");
    assert.deepEqual(result.classification.todoSuggestion, { name: "Rotate the leaked Redis key" });
    assert.deepEqual(resolveTodoSuggestion(result.classification), {
      name: "Rotate the leaked Redis key",
    });
  });

  test("over-classification drives exactly one second pass through classifyEmail and tags +2pass", async () => {
    // First pass spikes to urgent for a strong-bulk sender with no supporting
    // signal; the over-classification net fires one second pass that corrects
    // to newsletter and is final. Exercises the over_classification → second-
    // pass orchestration (detectConflict alone was unit-tested; this is e2e).
    const model = scriptedModel(
      classification({ category: "urgent", confidence: 0.8 }),
      classification({ category: "newsletter", confidence: 0.9 }),
    );
    const result = await classifyEmail(
      args({
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
    assert.equal(model.calls(), 2);
    assert.equal(result.audit.conflict?.kind, "over_classification");
    assert.equal(result.audit.secondPass?.category, "newsletter");
    assert.equal(result.classification.category, "newsletter");
    assert.match(result.model, /\+2pass$/);
  });

  test("a failing under-classification second pass records the failure and escalates conservatively", async () => {
    // Regression guard: a transient failure on the optional second pass must not
    // propagate (the workflow would force the message to the default `fyi`,
    // de-escalating it). Under-classification is the safety-critical direction,
    // so a passive first pass is not preserved either.
    let calls = 0;
    const runPass: RunPass = async ({ pass }) => {
      calls++;
      if (pass === "second") throw new Error("transient second-pass failure");
      return classification({ category: "newsletter", confidence: 0.7 });
    };
    const result = await classifyEmail(
      args({
        observations: observations({
          content: { ...observations().content, hasSecurityKeyword: true },
        }),
        runPass,
      }),
    );
    assert.equal(calls, 2); // conflict fired, second pass attempted
    assert.equal(result.audit.conflict?.kind, "under_classification");
    assert.equal(result.audit.secondPass, null);
    assert.match(result.audit.secondPassFailure?.message ?? "", /transient second-pass failure/);
    assert.equal(result.classification.category, "action_needed");
    assert.match(result.classification.rationale, /conservatively escalated/i);
    assert.equal(result.model, "injected+2pass_failed");
  });

  test("a failing over-classification second pass keeps the first pass but records the failure", async () => {
    let calls = 0;
    const runPass: RunPass = async ({ pass }) => {
      calls++;
      if (pass === "second") throw new Error("temporary outage");
      return classification({ category: "urgent", confidence: 0.7 });
    };
    const result = await classifyEmail(
      args({
        observations: observations({
          senderPrior: {
            key: "news@x.com",
            categoryCounts: { newsletter: 40 },
            lastCategory: "newsletter",
          },
        }),
        runPass,
      }),
    );
    assert.equal(calls, 2);
    assert.equal(result.audit.conflict?.kind, "over_classification");
    assert.equal(result.audit.secondPass, null);
    assert.match(result.audit.secondPassFailure?.message ?? "", /temporary outage/);
    assert.equal(result.classification.category, "urgent");
    assert.equal(result.model, "injected+2pass_failed");
  });
});

// ---------------------------------------------------------------------------
// Phase 0 — shipped todo contract (ADR-0050 amendment): schema shape + gate.
// Locks behavior the v3 classifier rewrite must preserve. The cheap model emits
// `todoSuggestion`; the workflow tail step mints a `suggested` todo ONLY through
// `resolveTodoSuggestion`, which is the single decision point for the rail.
// ---------------------------------------------------------------------------

describe("triageClassificationSchema.todoSuggestion", () => {
  function parseTodo(todoSuggestion: unknown, todoDecision: unknown = { outcome: "proposed" }) {
    return triageClassificationSchema.safeParse({
      category: "action_needed",
      confidence: 0.8,
      rationale: "x",
      todoSuggestion,
      todoDecision,
    });
  }

  test("accepts null", () => {
    assert.equal(parseTodo(null, { outcome: "no_obligation" }).success, true);
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

  test("accepts todo bookkeeping mismatches so the category survives parsing", () => {
    assert.equal(
      triageClassificationSchema.safeParse({
        category: "action_needed",
        confidence: 0.9,
        rationale: "x",
        todoSuggestion: { name: "Reply to Priya" },
      }).success,
      true,
    );
    assert.equal(parseTodo({ name: "Reply to Priya" }, { outcome: "too_vague" }).success, true);
    assert.equal(parseTodo(null, { outcome: "proposed" }).success, true);
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

describe("sanitizeAssist", () => {
  const anchor = new Date("2026-06-10T09:00:00Z");

  test("keeps an absolute date fragment", () => {
    assert.equal(sanitizeAssist("before Jun 30", anchor), "before Jun 30");
    assert.equal(sanitizeAssist("2026-06-30", anchor), "2026-06-30");
  });

  test("keeps a money fragment", () => {
    assert.equal(sanitizeAssist("₹88.5", anchor), "₹88.5");
  });

  test("resolves a relative date to an absolute calendar date against the email's send time", () => {
    assert.equal(sanitizeAssist("due tomorrow", anchor), "due Jun 11");
    assert.equal(sanitizeAssist("due tonight", anchor), "due Jun 10");
    assert.equal(sanitizeAssist("due today", anchor), "due Jun 10");
  });

  test("resolves a relative date alongside a money fragment", () => {
    assert.equal(sanitizeAssist("₹88.5 · due tomorrow", anchor), "₹88.5 · due Jun 11");
  });

  test("keeps a money fragment when an unanchored relative date is stripped", () => {
    assert.equal(sanitizeAssist("₹88.5 · due tomorrow", null), "₹88.5");
  });

  test("drops a bare relative date when there is no anchor to resolve it", () => {
    // Stripped to "due" → no hard fact left → title-only row.
    assert.equal(sanitizeAssist("due tomorrow", null), undefined);
  });

  test("drops relative phrasing it cannot pin to a single day", () => {
    assert.equal(sanitizeAssist("due next Friday", anchor), undefined);
    assert.equal(sanitizeAssist("in 3 days", anchor), undefined);
  });

  test("drops a sentence, a URL, or anything without a hard fact", () => {
    assert.equal(sanitizeAssist("she needs it Friday", anchor), undefined);
    assert.equal(sanitizeAssist("https://example.com/pay", anchor), undefined);
    assert.equal(sanitizeAssist("click the link", anchor), undefined);
    assert.equal(sanitizeAssist("", anchor), undefined);
    assert.equal(sanitizeAssist(null), undefined);
  });
});

describe("sanitizeTodoName", () => {
  test("strips an unambiguous hedge verb into an object-led title (log-sourced leaks)", () => {
    assert.equal(
      sanitizeTodoName("Investigate baserow response time alarm"),
      "Baserow response time alarm",
    );
    assert.equal(
      sanitizeTodoName("Look into Conservice admin view edit issue"),
      "Conservice admin view edit issue",
    );
    assert.equal(
      sanitizeTodoName("View task Eng in rotation Launch 26.3.5"),
      "Eng in rotation Launch 26.3.5",
    );
    assert.equal(
      sanitizeTodoName("Investigate the ElastiCache connection alarm"),
      "ElastiCache connection alarm",
    );
  });

  test("leaves a good title untouched", () => {
    assert.equal(
      sanitizeTodoName("Reply to Priya about the Q3 budget"),
      "Reply to Priya about the Q3 budget",
    );
    assert.equal(
      sanitizeTodoName("Rotate the exposed Redis credential"),
      "Rotate the exposed Redis credential",
    );
  });

  test("does NOT strip ambiguous verbs that can be the real action (left to rule 16f)", () => {
    // review/check/address have a legitimate "the action IS this verb" reading,
    // so they are deliberately out of scope — stripping would mangle them.
    assert.equal(
      sanitizeTodoName("Review the contract before signing"),
      "Review the contract before signing",
    );
    assert.equal(
      sanitizeTodoName("Check the wire transfer cleared"),
      "Check the wire transfer cleared",
    );
    assert.equal(
      sanitizeTodoName("Address Dependabot alerts in turbo-insta"),
      "Address Dependabot alerts in turbo-insta",
    );
  });

  test("never drops: a degenerate strip keeps the original rather than empty/one-word", () => {
    assert.equal(sanitizeTodoName("View the task"), "View the task");
    assert.equal(sanitizeTodoName("Investigate"), "Investigate");
    assert.equal(sanitizeTodoName("Look into it"), "Look into it");
  });

  test("does not false-match a hedge verb embedded in a longer word", () => {
    assert.equal(
      sanitizeTodoName("Viewer permissions for the shared doc"),
      "Viewer permissions for the shared doc",
    );
  });
});

describe("resolveTodoSuggestion", () => {
  const suggestion = { name: "Reply to Priya about the Q3 budget", assist: "before Jun 30" };

  test("repairs a hedge-shaped name on the proposed suggestion", () => {
    assert.deepEqual(
      resolveTodoSuggestion(
        classification({
          category: "action_needed",
          todoSuggestion: { name: "Investigate baserow response time alarm" },
          todoDecision: { outcome: "proposed" },
        }),
      ),
      { name: "Baserow response time alarm" },
    );
  });

  test("acceptance: an action_needed message with a concrete ask passes the suggestion through", () => {
    const resolved = resolveTodoSuggestion(
      classification({
        category: "action_needed",
        todoSuggestion: suggestion,
        todoDecision: { outcome: "proposed" },
      }),
    );
    assert.deepEqual(resolved, suggestion);
  });

  test("urgent with a concrete ask passes through", () => {
    assert.deepEqual(
      resolveTodoSuggestion(
        classification({
          category: "urgent",
          todoSuggestion: { name: "Rotate the Redis key" },
          todoDecision: { outcome: "proposed" },
        }),
      ),
      { name: "Rotate the Redis key" },
    );
  });

  // Floor (ADR-0050 amendment 2026-06-06) = {marketing, newsletter} only: a
  // genuine obligation on a broadcast bucket is misclassification leaking
  // through, so suppress it as a consistency guard.
  for (const category of ["marketing", "newsletter"] as const) {
    test(`floor: ${category} suppresses a stray suggestion the model emitted anyway`, () => {
      assert.equal(
        resolveTodoSuggestion(
          classification({
            category,
            todoSuggestion: suggestion,
            todoDecision: { outcome: "proposed" },
          }),
        ),
        null,
      );
    });
  }

  // fyi/done are NO LONGER floored — the rubric (rule 16) owns them, since an
  // fyi can carry a real obligation and a done closure can end with a real ask.
  // When the model proposes on one (rubric passed), the suggestion goes through.
  for (const category of ["fyi", "done"] as const) {
    test(`rubric-owned: ${category} passes a suggestion the model proposed (no longer floored)`, () => {
      assert.deepEqual(
        resolveTodoSuggestion(
          classification({
            category,
            todoSuggestion: suggestion,
            todoDecision: { outcome: "proposed" },
          }),
        ),
        suggestion,
      );
    });
  }

  test("resolves a relative deadline in the assist against the email's send time", () => {
    assert.deepEqual(
      resolveTodoSuggestion(
        classification({
          category: "action_needed",
          todoSuggestion: { name: "Pay the electricity bill", assist: "₹880 · due tomorrow" },
          todoDecision: { outcome: "proposed" },
        }),
        new Date("2026-06-10T09:00:00Z"),
      ),
      { name: "Pay the electricity bill", assist: "₹880 · due Jun 11" },
    );
  });

  test("null when todoDecision does not confirm the proposal", () => {
    assert.equal(
      resolveTodoSuggestion(
        classification({
          category: "action_needed",
          todoSuggestion: suggestion,
          todoDecision: { outcome: "too_vague" },
        }),
      ),
      null,
    );
  });

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
