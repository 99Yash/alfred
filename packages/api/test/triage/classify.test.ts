import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyMeetingDemotionFloor,
  applyOverrideFloor,
  applySenderKindDemotionFloor,
  classifyEmail,
  detectConflict,
  noteMarksFailingOutcome,
  normalizeClassifierOutput,
  resolveTodoSuggestion,
  sanitizeAssist,
  sanitizeTodoName,
  SYSTEM_PROMPT,
  todoSuppressionReason,
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
    senderRelationshipIsCold: false,
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
  const serviceKind = {
    ...groupKind,
    kind: "service" as const,
    confidence: 0.92,
    evidenceCodes: ["email:local:service_strong"],
  };
  const serviceRoleKind = {
    ...serviceKind,
    evidenceCodes: ["email:local:service"],
    displayName: "Support",
  };

  test("demotes awaiting_reply → fyi for a confident group sender (never buries)", () => {
    const r = applySenderKindDemotionFloor(
      classification({
        category: "awaiting_reply",
        confidence: 0.9,
        todoSuggestion: { name: "Reply to LinkedIn request" },
        todoDecision: { outcome: "proposed" },
      }),
      groupKind,
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
    assert.equal(r.classification.todoSuggestion, null);
    assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
    assert.equal(resolveTodoSuggestion(r.classification), null);
    assert.match(r.classification.rationale, /sender-kind floor/i);
  });

  test("demotes awaiting_reply → fyi for a confident no-reply service sender too", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "awaiting_reply" }),
      serviceKind,
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("leaves support/billing-style service role mailboxes untouched", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "awaiting_reply" }),
      serviceRoleKind,
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "awaiting_reply");
  });

  test("demotes action_needed → fyi for a passive collaboration state transition", () => {
    const r = applySenderKindDemotionFloor(
      classification({
        category: "action_needed",
        todoSuggestion: { name: "Move the task forward" },
        todoDecision: { outcome: "proposed" },
      }),
      serviceKind,
      { signalText: "dvd set the status to: 10 web\nchanged status\n07 merged\n10 web" },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
    assert.equal(r.classification.todoSuggestion, null);
    assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
    assert.equal(resolveTodoSuggestion(r.classification), null);
  });

  test("leaves assigned action_needed untouched — a group/service CAN assign a real action (ADR-0066)", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        signalText:
          "Sakshi Jindal assigned task to you\nConservice: Show all CRM fields as options",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("leaves direct-ask action_needed untouched in collaboration comments", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        signalText:
          "Sanyam commented\npls merge this - https://github.com/OlivAIRepo/autosched-mirror/pull/654",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("does not treat bare resolved prose as a state transition", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        signalText:
          "fetch-latest-report resolved to a stale report because mixed date formats sorted badly",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  // --- #218: collabActivity model-field floor (ClickUp/Linear residual tail) ---
  // The body is the ambiguous assignment/mention/comment prose that no
  // state-transition regex matches — the model's `collabActivity` read is the
  // signal. Passive kinds demote; ownership kinds keep.

  for (const kind of ["state_change", "other_activity", "digest"] as const) {
    test(`demotes action_needed → fyi on passive collabActivity=${kind} (no state-transition regex)`, () => {
      const r = applySenderKindDemotionFloor(
        classification({
          category: "action_needed",
          todoSuggestion: { name: "Handle the ClickUp task" },
          todoDecision: { outcome: "proposed" },
        }),
        serviceKind,
        {
          signalText: "Conservice: Show all CRM fields as options\nActivity in your workspace",
          collabActivity: kind,
        },
      );
      assert.equal(r.demoted, true);
      assert.equal(r.classification.category, "fyi");
      assert.equal(r.classification.todoSuggestion, null);
      assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
      assert.equal(resolveTodoSuggestion(r.classification), null);
    });
  }

  for (const kind of ["assigned_to_user", "mentioned_user", "comment_to_user"] as const) {
    test(`keeps action_needed on ownership collabActivity=${kind} (directed at the user)`, () => {
      const r = applySenderKindDemotionFloor(
        classification({ category: "action_needed" }),
        serviceKind,
        {
          signalText: "Conservice: Show all CRM fields as options",
          collabActivity: kind,
        },
      );
      assert.equal(r.demoted, false);
      assert.equal(r.classification.category, "action_needed");
    });
  }

  for (const kind of ["mentioned_user", "comment_to_user"] as const) {
    test(`keeps awaiting_reply on ownership collabActivity=${kind} (direct reply owed by user)`, () => {
      const r = applySenderKindDemotionFloor(
        classification({
          category: "awaiting_reply",
          todoSuggestion: { name: "Reply to the task comment" },
          todoDecision: { outcome: "proposed" },
        }),
        serviceKind,
        {
          signalText: "Akshay mentioned you in a comment\n@yash.k can you confirm this today?",
          collabActivity: kind,
        },
      );
      assert.equal(r.demoted, false);
      assert.equal(r.reason, null);
      assert.equal(r.classification.category, "awaiting_reply");
      assert.deepEqual(r.classification.todoSuggestion, { name: "Reply to the task comment" });
    });
  }

  test("collabActivity model field wins over a stray state-transition regex match", () => {
    // Body would match the passive-state-transition regex, but the model read the
    // notification as assigned to the user — the model field takes precedence.
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        signalText: "changed status to In Progress\nAkshay assigned this to you",
        collabActivity: "assigned_to_user",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("ownership collabActivity blocks other passive sender-kind reasons too", () => {
    const r = applySenderKindDemotionFloor(
      classification({
        category: "action_needed",
        todoSuggestion: { name: "Merge the PR" },
        todoDecision: { outcome: "proposed" },
        collabActivity: "mentioned_user",
      }),
      serviceKind,
      {
        sender: "GitHub <notifications@github.com>",
        subject: "Re: [org/repo] Deal Merge Flow (PR #654)",
        cc: "Yash <yash@example.com>, Author <author@noreply.github.com>",
        signalText: "Sanyam mentioned you in a comment\n@yash.k pls merge this PR before release",
        collabActivity: "mentioned_user",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.reason, null);
    assert.equal(r.classification.category, "action_needed");
    assert.deepEqual(r.classification.todoSuggestion, { name: "Merge the PR" });
  });

  test("passive collabActivity with an exposed-secret body is NOT demoted (secret veto)", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        signalText: "activity on card\nAWS secret key was exposed in the logs",
        collabActivity: "other_activity",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("passive collabActivity with a real money stake is NOT demoted (intrinsic-stake veto)", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        signalText: "workspace activity\nyour invoice is past due — card declined",
        collabActivity: "digest",
      },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("passive collabActivity demotes when only the task title carries scary words", () => {
    const r = applySenderKindDemotionFloor(
      classification({
        category: "action_needed",
        todoSuggestion: { name: "Handle the ClickUp task" },
        todoDecision: { outcome: "proposed" },
      }),
      serviceKind,
      {
        signalText:
          "Critical security payment task\nAkash commented\nyes good catch\nView comment or reply",
        collabVetoText: "Akash commented\nyes good catch\nView comment or reply",
        collabActivity: "other_activity",
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.reason, "collab_passive_activity");
    assert.equal(r.classification.category, "fyi");
  });

  test("passive collabActivity from a weak service-role mailbox is spared (evidence gate)", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceRoleKind,
      { signalText: "activity in your workspace", collabActivity: "other_activity" },
    );
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "action_needed");
  });

  test("demotes GitHub PR notifications where Cc structurally says the user is the author", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        sender: "Copilot <notifications@github.com>",
        subject: "Re: [99Yash/alfred] show settings (PR #122)",
        cc: "Yash Gourav Kar <yashgouravkar@gmail.com>, Author <author@noreply.github.com>",
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("demotes GitHub CI notifications from the structural Cc reason alias", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        sender: "Yash Gourav Kar <notifications@github.com>",
        subject: "[99Yash/alfred] PR run failed: triage-eval - feat(chat) (b560b46)",
        cc: "Ci activity <ci_activity@noreply.github.com>",
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("does not demote GitHub security or direct no-reason notifications through the PR/CI gate", () => {
    const security = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        sender: "GitHub <notifications@github.com>",
        subject: "[GitHub] Security alert",
        cc: "Security alert <security_alert@noreply.github.com>",
      },
    );
    assert.equal(security.demoted, false);
    assert.equal(security.classification.category, "action_needed");

    const invite = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        sender: "Ronit Panda <noreply@github.com>",
        subject: "rtpa25 invited you to rtpa25/-dimension-ai-web",
        cc: null,
      },
    );
    assert.equal(invite.demoted, false);
    assert.equal(invite.classification.category, "action_needed");
  });

  test("demotes urgent → fyi for a group-broadcast auth sign-in confirmation", () => {
    const r = applySenderKindDemotionFloor(
      classification({
        category: "urgent",
        todoSuggestion: { name: "Review OpenAI account security" },
        todoDecision: { outcome: "proposed" },
      }),
      groupKind,
      {
        subject: "New sign-in to your OpenAI account",
        signalText:
          "We noticed a new sign-in to your OpenAI account. " +
          "If this was you, no action is needed. " +
          "If you don't recognize this activity, please review your account security right away.",
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
    assert.equal(r.classification.todoSuggestion, null);
    assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
    assert.equal(resolveTodoSuggestion(r.classification), null);
  });

  test("leaves direct service auth sign-in alerts urgent", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), serviceKind, {
      subject: "New sign-in to your OpenAI account",
      signalText:
        "We noticed a new sign-in to your OpenAI account. " +
        "If this was you, no action is needed. " +
        "If you don't recognize this activity, please review your account security right away.",
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("leaves unrelated urgent group notifications untouched", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      signalText: "Production outage: deploys are blocked and customer API requests are failing.",
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  // --- #354: monitoring-alarm broadcasts (shape AND audience) ---
  const ACCOUNT = "yash.k@oliv.ai";

  test("demotes urgent → fyi for a CloudWatch/SNS alarm broadcast the user is not addressed on", () => {
    const r = applySenderKindDemotionFloor(
      classification({
        category: "urgent",
        todoSuggestion: { name: "Investigate baserow response time" },
        todoDecision: { outcome: "proposed" },
      }),
      groupKind,
      {
        sender: "AWS Notifications <no-reply@sns.amazonaws.com>",
        subject: 'ALARM: "baserow-response-time" in EU (Ireland)',
        signalText:
          'ALARM: "baserow-response-time" in EU (Ireland)\n' +
          "Threshold Crossed: 1 datapoint greater than the threshold (2000.0).",
        to: "engineering@oliv.ai",
        accountEmail: ACCOUNT,
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
    assert.equal(r.classification.todoSuggestion, null);
    assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
    assert.equal(resolveTodoSuggestion(r.classification), null);
    assert.match(r.classification.rationale, /sender-kind floor/i);
  });

  test("demotes action_needed → fyi for a broadcast monitoring alarm too", () => {
    const r = applySenderKindDemotionFloor(
      classification({ category: "action_needed" }),
      serviceKind,
      {
        sender: "Grafana <alerts@grafana.net>",
        subject: "[ALERTING] ElastiCache CurrConnections high",
        signalText: "ALERT: ElastiCache CurrConnections is above the configured threshold.",
        to: "oncall@oliv.ai",
        accountEmail: ACCOUNT,
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("keeps a monitoring alarm the user is directly addressed on (To)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "AWS Notifications <no-reply@sns.amazonaws.com>",
      subject: 'ALARM: "checkout-error-rate" in us-east-1',
      signalText: "ALARM: checkout-error-rate crossed the threshold.",
      to: `On-call <${ACCOUNT}>`,
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("keeps a monitoring alarm when the user is in Cc (still a direct addressee)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: prod-db-cpu",
      signalText: "ALARM: prod-db-cpu is high.",
      to: "engineering@oliv.ai",
      cc: ACCOUNT,
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("keeps a monitoring alarm when identity is unknown (cannot prove broadcast)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: prod-db-cpu",
      signalText: "ALARM: prod-db-cpu is high.",
      to: "engineering@oliv.ai",
      accountEmail: null,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("keeps a monitoring alarm with no recipient headers (cannot prove broadcast)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: prod-db-cpu",
      signalText: "ALARM: prod-db-cpu is high.",
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("does not infer alarm ownership from body prose without direct envelope evidence", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: 'ALARM: "payments-api" down',
      signalText:
        'ALARM: "payments-api" is down. @yash can you pick this up — you are the on-call owner.',
      to: "engineering@oliv.ai",
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("demotes a broadcast alarm whose boilerplate footer merely contains 'please' (#354 regression)", () => {
    // The real prod failure: every CloudWatch/SNS alarm relayed through the
    // `engineering@oliv.ai` Google Group carries list boilerplate — CloudWatch's
    // "You are receiving this email…" preamble and a "…please visit the link to
    // unsubscribe" footer. COLLAB_DIRECT_OWNERSHIP_RE read that bare "please" as a
    // direct ask and vetoed EVERY demotion, so 26 SNS broadcasts stayed `urgent`
    // with no `+kindfloor`. Alarm ownership must not be inferred from body prose.
    const r = applySenderKindDemotionFloor(
      classification({
        category: "urgent",
        todoSuggestion: { name: "Investigate baserow response time" },
        todoDecision: { outcome: "proposed" },
      }),
      groupKind,
      {
        sender: "AWS Notifications <no-reply@sns.amazonaws.com>",
        subject: 'ALARM: "baserow-response-time" in US East (Ohio)',
        signalText:
          'ALARM: "baserow-response-time" in US East (Ohio)\n' +
          "You are receiving this email because your Amazon CloudWatch Alarm entered the ALARM state.\n" +
          "Threshold Crossed: 1 datapoint was greater than the threshold (10.0).\n" +
          '--\nYou received this message because you are subscribed to the Google Groups "Engineering" group.\n' +
          "To unsubscribe, please visit https://groups.google.com/a/oliv.ai/unsubscribe.",
        to: "engineering@oliv.ai",
        accountEmail: ACCOUNT,
      },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
    assert.equal(resolveTodoSuggestion(r.classification), null);
    assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
  });

  test("keeps a broadcast alarm that also exposes a secret (secret escapes demotion)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: secret scanner",
      signalText: "ALARM: an API key was leaked in the build logs — rotate it now.",
      to: "engineering@oliv.ai",
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("keeps an urgent broadcast that is NOT monitoring-shaped (shape gate)", () => {
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "Ops <ops@oliv.ai>",
      subject: "All hands: production incident war room now",
      signalText: "Join the incident bridge — customer API requests are failing.",
      to: "engineering@oliv.ai",
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("keeps a monitoring alarm the user is addressed on via a Gmail plus-tag", () => {
    // `yash.k+alerts@oliv.ai` does not contain `yash.k@oliv.ai` as a substring —
    // the old raw-substring test over-demoted this direct (plus-addressed) recipient.
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: prod-db-cpu",
      signalText: "ALARM: prod-db-cpu is high.",
      to: `Alerts <yash.k+alerts@oliv.ai>`,
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "urgent");
  });

  test("demotes a broadcast whose recipient merely CONTAINS the account as a substring", () => {
    // `notyash.k@oliv.ai` contains `yash.k@oliv.ai` — a raw substring test wrongly
    // read the user as addressed and kept the category; exact membership demotes.
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: prod-db-cpu",
      signalText: "ALARM: prod-db-cpu is high.",
      to: "notyash.k@oliv.ai",
      accountEmail: ACCOUNT,
    });
    assert.equal(r.demoted, true);
    assert.equal(r.classification.category, "fyi");
  });

  test("keeps a monitoring alarm to a quoted-name recipient list the user is in", () => {
    // Comma inside a quoted display name must not corrupt token boundaries.
    const r = applySenderKindDemotionFloor(classification({ category: "urgent" }), groupKind, {
      sender: "no-reply@sns.amazonaws.com",
      subject: "ALARM: prod-db-cpu",
      signalText: "ALARM: prod-db-cpu is high.",
      to: `"Doe, Jane" <jane@oliv.ai>, "Kar, Yash" <${ACCOUNT}>`,
      accountEmail: ACCOUNT,
    });
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
// applyMeetingDemotionFloor
// ---------------------------------------------------------------------------

describe("applyMeetingDemotionFloor", () => {
  const serviceKind = {
    kind: "service" as const,
    confidence: 0.92,
    evidenceCodes: ["email:local:service_strong"],
    entityId: "ent_1",
    displayName: "ClickUp",
  };
  const groupKind = { ...serviceKind, kind: "group" as const, evidenceCodes: ["gmail:list_id"] };

  test("demotes a post-hoc recap → fyi even from a person-parsed sender (oliv.guide)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting", confidence: 1 }), {
      effectiveAuthor: "person",
      subject: "Meeting notes: Eng standup • Thu, Jul 02, 2026 10:45 AM IST",
    });
    assert.equal(r.demoted, true);
    assert.equal(r.reason, "meeting_recap");
    assert.equal(r.classification.category, "fyi");
    assert.match(r.classification.rationale, /meeting floor/i);
  });

  test("demotes a pre-meeting prep brief → fyi (bracket-prefixed subject too)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "person",
      subject: "[Beta] Meeting prep: Oliv AI <> Practifi | Weekly Sync",
    });
    assert.equal(r.demoted, true);
    assert.equal(r.reason, "meeting_prep");
    assert.equal(r.classification.category, "fyi");
  });

  test("demotes a passive collab-tool relay → fyi and clears the stray todo (offsite)", () => {
    const r = applyMeetingDemotionFloor(
      classification({
        category: "meeting",
        confidence: 0.8,
        todoSuggestion: { name: "Attend the offsite in August" },
        todoDecision: { outcome: "proposed" },
        collabActivity: "other_activity",
      }),
      { effectiveAuthor: "service", senderKind: serviceKind, subject: "Offsite" },
    );
    assert.equal(r.demoted, true);
    assert.equal(r.reason, "automated_relay");
    assert.equal(r.classification.category, "fyi");
    assert.equal(r.classification.todoSuggestion, null);
    assert.equal(r.classification.todoDecision?.outcome, "no_obligation");
    assert.equal(resolveTodoSuggestion(r.classification), null);
  });

  test("keeps automated non-collab meeting mail unless a narrower meeting-floor reason fires", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "person",
      senderKind: groupKind,
      subject: "Engineering",
    });
    assert.equal(r.demoted, false);
    assert.equal(r.reason, null);
  });

  test("KEEPS a genuine calendar invite from a person organizer", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting", confidence: 1 }), {
      effectiveAuthor: "person",
      subject: "Updated invitation: Eng standup @ Wed Jul 8, 2026 11am - 12pm (IST)",
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "meeting");
  });

  test("KEEPS a genuine calendar invite even from a service calendar address (carve-out)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "service",
      senderKind: serviceKind,
      subject: "Invitation: Weekly Sync @ Thu Jul 10",
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "meeting");
  });

  test("KEEPS Calendar scheduling and attendance-action subjects from service addresses", () => {
    const subjects = [
      "Proposed new time: Max <> Andriy 1on1 @ Thu Jan 9, 2025 11:30am - 12pm",
      "Canceled: Weekly Sync",
      "Reminder: Weekly Sync starts in 10 minutes",
      "Updated invitation with note: Weekly Sync @ Thu Jul 10",
    ];
    for (const subject of subjects) {
      const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
        effectiveAuthor: "service",
        senderKind: serviceKind,
        subject,
      });
      assert.equal(r.demoted, false, subject);
      assert.equal(r.classification.category, "meeting", subject);
    }
  });

  test("KEEPS a real scheduling ask from a person (non-invite subject, not automated)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "person",
      subject: "Can you do a call this week?",
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "meeting");
  });

  test("demotes an AGM/investor notice → fyi via the content flag (rule 9)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "person",
      subject: "SUNDRAM FASTENERS LIMITED - 63rd Annual General Meeting",
      contentFlags: { hasInvestorNotice: true, hasPublicEventLanguage: false },
    });
    assert.equal(r.demoted, true);
    assert.equal(r.reason, "investor_notice");
    assert.equal(r.classification.category, "fyi");
  });

  test("demotes a webinar/public-event blast → fyi via the content flag (rule 8)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "person",
      subject: "Don't Miss Tuesday's Webinar on Practitioner's Guide",
      contentFlags: { hasInvestorNotice: false, hasPublicEventLanguage: true },
    });
    assert.equal(r.demoted, true);
    assert.equal(r.reason, "public_event");
    assert.equal(r.classification.category, "fyi");
  });

  test("KEEPS a real invite even when the body trips an investor/public-event flag (carve-out)", () => {
    const r = applyMeetingDemotionFloor(classification({ category: "meeting" }), {
      effectiveAuthor: "person",
      subject: "Invitation: Prep sync for the shareholder AGM",
      contentFlags: { hasInvestorNotice: true, hasPublicEventLanguage: true },
    });
    assert.equal(r.demoted, false);
    assert.equal(r.classification.category, "meeting");
  });

  test("is a no-op for any non-meeting category", () => {
    const c = classification({ category: "action_needed" });
    const r = applyMeetingDemotionFloor(c, {
      effectiveAuthor: "service",
      subject: "Offsite",
      contentFlags: { hasInvestorNotice: true, hasPublicEventLanguage: true },
    });
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
    const model = scriptedModel(
      classification({
        category: "awaiting_reply",
        confidence: 0.9,
        todoSuggestion: { name: "Reply to LinkedIn request" },
        todoDecision: { outcome: "proposed" },
      }),
    );
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
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("sender-kind floor demotes a ClickUp-shaped status change end-to-end", async () => {
    const model = scriptedModel(
      classification({
        category: "action_needed",
        confidence: 0.88,
        todoSuggestion: { name: "Review upload workflow status" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_clickup_status",
          title: "Upload meeting workflow bugs",
          content:
            "From: Oliv AI <notifications@tasks.clickup.com>\n" +
            "To: yash.k@oliv.ai\n\n" +
            "dvd set the status to: 10 web\n" +
            "Upload meeting workflow bugs\n" +
            "dvd changed status\n" +
            "07 merged\n" +
            "10 web\n" +
            "View task or reply to add a comment",
          authoredAt: null,
          metadata: {},
        },
        observations: observations({
          senderKind: {
            kind: "service",
            confidence: 0.92,
            evidenceCodes: ["email:local:service_strong"],
            entityId: "ent_clickup",
            displayName: "Oliv AI",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.senderKindDemoted, true);
    assert.equal(result.model, "injected+kindfloor");
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("sender-kind floor demotes model-emitted passive collabActivity end-to-end", async () => {
    const model = scriptedModel(
      classification({
        category: "action_needed",
        confidence: 0.88,
        todoSuggestion: { name: "Review the ClickUp task" },
        todoDecision: { outcome: "proposed" },
        collabActivity: "other_activity",
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_clickup_passive_comment",
          title: "Critical security payment task title",
          content:
            "From: Oliv AI <notifications@tasks.clickup.com>\n" +
            "To: yash.k@oliv.ai\n\n" +
            "Akash Ojha commented\n" +
            "yes good catch\n" +
            "View comment or reply to add a comment",
          authoredAt: null,
          metadata: {
            from: "Oliv AI <notifications@tasks.clickup.com>",
            to: "yash.k@oliv.ai",
          },
        },
        observations: observations({
          senderKind: {
            kind: "service",
            confidence: 0.92,
            evidenceCodes: ["email:local:service_strong"],
            entityId: "ent_clickup",
            displayName: "Oliv AI",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.classification.collabActivity, "other_activity");
    assert.equal(result.audit.firstPass.collabActivity, "other_activity");
    assert.equal(result.audit.senderKindDemoted, true);
    assert.equal(result.audit.senderKindDemotionReason, "collab_passive_activity");
    assert.equal(result.model, "injected+kindfloor");
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("meeting floor demotes a passive collab meeting relay end-to-end and records audit", async () => {
    const model = scriptedModel(
      classification({
        category: "meeting",
        confidence: 0.86,
        todoSuggestion: { name: "Attend the offsite in August" },
        todoDecision: { outcome: "proposed" },
        collabActivity: "other_activity",
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_clickup_offsite",
          title: "Offsite",
          content:
            "From: Oliv AI <notifications@tasks.clickup.com>\n" +
            "To: yash.k@oliv.ai\n\n" +
            "@everyone we'll meet in-person for the offsite in Aug; I'll confirm the dates.",
          authoredAt: null,
          metadata: {
            from: "Oliv AI <notifications@tasks.clickup.com>",
            to: "yash.k@oliv.ai",
          },
        },
        observations: observations({
          senderKind: {
            kind: "service",
            confidence: 0.92,
            evidenceCodes: ["email:local:service_strong"],
            entityId: "ent_clickup",
            displayName: "Oliv AI",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.senderKindDemoted, false);
    assert.equal(result.audit.meetingDemoted, true);
    assert.equal(result.audit.meetingDemotionReason, "automated_relay");
    assert.equal(result.model, "injected+meetingfloor");
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("sender-kind floor preserves model-emitted ownership collabActivity awaiting_reply end-to-end", async () => {
    const model = scriptedModel(
      classification({
        category: "awaiting_reply",
        confidence: 0.88,
        todoSuggestion: { name: "Reply to the merge question" },
        todoDecision: { outcome: "proposed" },
        collabActivity: "mentioned_user",
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_clickup_direct_mention",
          title: "Deal Merge Flow",
          content:
            "From: Oliv AI <notifications@tasks.clickup.com>\n" +
            "To: yash.k@oliv.ai\n\n" +
            "Akshay mentioned you in a comment\n" +
            "@yash.k can you confirm whether the merge dedupes by external id before we ship?",
          authoredAt: null,
          metadata: {
            from: "Oliv AI <notifications@tasks.clickup.com>",
            to: "yash.k@oliv.ai",
          },
        },
        observations: observations({
          senderKind: {
            kind: "service",
            confidence: 0.92,
            evidenceCodes: ["email:local:service_strong"],
            entityId: "ent_clickup",
            displayName: "Oliv AI",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "awaiting_reply");
    assert.equal(result.classification.collabActivity, "mentioned_user");
    assert.equal(result.audit.senderKindDemoted, false);
    assert.equal(result.audit.senderKindDemotionReason, null);
    assert.equal(result.model, "injected");
    assert.deepEqual(resolveTodoSuggestion(result.classification), {
      name: "Reply to the merge question",
    });
  });

  test("sender-kind floor demotes a GitHub author PR notification from metadata", async () => {
    const model = scriptedModel(
      classification({
        category: "action_needed",
        confidence: 0.86,
        todoSuggestion: { name: "Address PR review comments" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_github_pr_author",
          title: "Re: [99Yash/alfred] show settings (PR #122)",
          content: "A reviewer commented on this pull request.",
          authoredAt: null,
          metadata: {
            from: "Copilot <notifications@github.com>",
            cc: "Yash Gourav Kar <yashgouravkar@gmail.com>, Author <author@noreply.github.com>",
          },
        },
        observations: observations({
          senderKind: {
            kind: "service",
            confidence: 0.9,
            evidenceCodes: ["email:local:service_strong"],
            entityId: "ent_github",
            displayName: "GitHub Notifications",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.senderKindDemoted, true);
    assert.equal(result.model, "injected+kindfloor");
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("sender-kind floor demotes group-broadcast sign-in confirmations end-to-end", async () => {
    const model = scriptedModel(
      classification({
        category: "urgent",
        confidence: 0.9,
        todoSuggestion: { name: "Review OpenAI account security" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_openai_group_signin",
          title: "New sign-in to your OpenAI account",
          content:
            "From: 'OpenAI' via Engineering <engineering@oliv.ai>\n" +
            "To: dev.pro.2@oliv.ai\n\n" +
            "We noticed a new sign-in to your OpenAI account.\n\n" +
            "App: ChatGPT Web\n" +
            "Location: Kolkata\n" +
            "Device: Chrome on Mac OS X\n\n" +
            "If this was you, no action is needed.\n" +
            "If you don't recognize this activity, please review your account security right away.",
          authoredAt: null,
          metadata: {
            from: "'OpenAI' via Engineering <engineering@oliv.ai>",
          },
        },
        observations: observations({
          senderKind: {
            kind: "group",
            confidence: 0.99,
            evidenceCodes: ["gmail:list_id", "gmail:list_unsubscribe", "gmail:precedence:list"],
            entityId: "ent_engineering",
            displayName: "Engineering",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.senderKindDemoted, true);
    assert.equal(result.audit.firstPass.category, "urgent");
    assert.equal(result.model, "injected+kindfloor");
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("sender-kind floor demotes a monitoring-alarm broadcast end-to-end (threads to + identity)", async () => {
    // Guards the two fields #354 added to the floor context — `metadata.to` and
    // `identity.email`. A refactor that drops `identity` makes `accountEmail` null,
    // `isBroadcastAudience` returns false, and the floor silently no-ops in prod;
    // the predicate-level tests would still pass. This locks the wiring end-to-end.
    const model = scriptedModel(
      classification({
        category: "urgent",
        confidence: 0.9,
        todoSuggestion: { name: "Investigate baserow response time" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_sns_alarm_broadcast",
          title: 'ALARM: "baserow-response-time" in EU (Ireland)',
          content:
            "From: AWS Notifications <no-reply@sns.amazonaws.com>\n" +
            "To: engineering@oliv.ai\n\n" +
            "Threshold Crossed: 1 datapoint greater than the threshold (2000.0).",
          authoredAt: null,
          metadata: {
            from: "AWS Notifications <no-reply@sns.amazonaws.com>",
            to: "engineering@oliv.ai",
          },
        },
        identity: { email: "yash.k@oliv.ai" },
        observations: observations({
          senderKind: {
            kind: "group",
            confidence: 0.99,
            evidenceCodes: ["gmail:list_id"],
            entityId: "ent_sns",
            displayName: "AWS Notifications",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.senderKindDemoted, true);
    assert.equal(result.audit.firstPass.category, "urgent");
    assert.equal(result.model, "injected+kindfloor");
    assert.equal(resolveTodoSuggestion(result.classification), null);
  });

  test("secret override wins before sender-kind demotion and preserves a security todo", async () => {
    const model = scriptedModel(
      classification({
        category: "awaiting_reply",
        confidence: 0.7,
        todoSuggestion: { name: "Rotate the leaked key" },
        todoDecision: { outcome: "proposed" },
      }),
    );
    const result = await classifyEmail(
      args({
        document: {
          id: "doc_secret_from_group",
          title: "Security alert",
          content: "GitHub detected a private key in your repository.",
          authoredAt: null,
          metadata: {},
        },
        observations: observations({
          senderKind: {
            kind: "group",
            confidence: 0.99,
            evidenceCodes: ["gmail:list_id"],
            entityId: "ent_1",
            displayName: "GitHub",
          },
        }),
        runPass: model.runPass,
      }),
    );
    assert.equal(result.classification.category, "urgent");
    assert.equal(result.audit.floorForced, true);
    assert.equal(result.audit.senderKindDemoted, false);
    assert.equal(result.model, "injected+floor");
    assert.deepEqual(resolveTodoSuggestion(result.classification), {
      name: "Rotate the leaked key",
    });
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
  test("normalizes omitted collabActivity to null at the classifier boundary", () => {
    const output = normalizeClassifierOutput({
      category: "fyi",
      confidence: 1.4,
      rationale: "not a collaboration notification",
      todoSuggestion: null,
      todoDecision: { outcome: "no_obligation" },
    });
    assert.equal(output.confidence, 1);
    assert.equal(output.collabActivity, null);
  });

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

  // Contradiction backstop: the model returns `proposed` but names a
  // disqualifying reason in the note (the HyperNexus cold-outreach leak: it
  // wrote `cold_sender:` yet proposed anyway). Drop it — the note is the model
  // disagreeing with its own outcome.
  for (const note of [
    "cold_sender:",
    "cold_sender: pelloni.robert@gmail.com",
    "manufactured:",
    "advisory: pre-merge PR review",
  ]) {
    test(`backstop: proposed with a failing-outcome note ("${note}") mints no todo`, () => {
      assert.equal(
        resolveTodoSuggestion(
          classification({
            category: "awaiting_reply",
            todoSuggestion: suggestion,
            todoDecision: { outcome: "proposed", note },
          }),
        ),
        null,
      );
    });
  }

  test("backstop: a benign note on a proposed decision still passes", () => {
    assert.deepEqual(
      resolveTodoSuggestion(
        classification({
          category: "action_needed",
          todoSuggestion: suggestion,
          todoDecision: { outcome: "proposed", note: "real two-way contact, direct ask" },
        }),
      ),
      suggestion,
    );
  });

  // Coupling guard: the backstop only works if the prompt actually instructs the
  // model to emit these exact note prefixes on a failing outcome. If the prompt
  // convention drifts (`cold-sender:`, `[cold_sender]`, …) the backstop silently
  // dies — pin the three markers to the prompt AND to the matcher.
  for (const prefix of ["cold_sender:", "manufactured:", "advisory:"] as const) {
    test(`coupling: SYSTEM_PROMPT emits the "${prefix}" note the backstop matches`, () => {
      assert.ok(
        SYSTEM_PROMPT.includes(prefix),
        `prompt must instruct the model to emit note prefix "${prefix}"`,
      );
      assert.equal(noteMarksFailingOutcome(`${prefix} some detail`), true);
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

describe("todoSuppressionReason", () => {
  const base = { sender: null, subject: null, signalText: "", collabActivity: null } as const;

  test("tracker_owned: a ClickUp assignment (model read: assigned_to_user) mints no todo", () => {
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "Oliv AI <notifications@tasks.clickup.com>",
        subject: "Customer / Netsmart",
        signalText: "sakshi jindal mentioned @yash kar and asked him to fix the save button",
        collabActivity: "assigned_to_user",
      }),
      "tracker_owned",
    );
  });

  test("tracker_owned: an @-mention comment (model read: mentioned_user) mints no todo", () => {
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "Oliv AI <notifications@tasks.clickup.com>",
        signalText: "akshay jyothis mentioned @yash kar: have you checked this?",
        collabActivity: "mentioned_user",
      }),
      "tracker_owned",
    );
  });

  test("tracker_owned via sender fallback when the model OMITS collabActivity (~1-in-5)", () => {
    // The #447 reality: flash-lite drops the collabActivity key on some collab
    // mail. The known-tracker sender still suppresses so the rail is not clogged.
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "notifications@tasks.clickup.com",
        signalText: "assigned task to you",
        collabActivity: null,
      }),
      "tracker_owned",
    );
  });

  for (const sender of [
    "notifications@linear.app",
    "jira@oliv.atlassian.net",
    "no-reply@asana.com",
    "notifications@notify.notion.so",
  ]) {
    test(`tracker_owned: known tracker sender ${sender}`, () => {
      assert.equal(
        todoSuppressionReason({ ...base, sender, signalText: "assigned to you" }),
        "tracker_owned",
      );
    });
  }

  test("KEEP: a genuine person-to-person ask is not tracker-owned", () => {
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "Priya <priya@acme.com>",
        subject: "Q3 budget",
        signalText: "can you send me the signed SOW by friday?",
        collabActivity: null,
      }),
      null,
    );
  });

  test("KEEP: an exposed secret escapes tracker_owned suppression (still a todo)", () => {
    // A leaked credential outlives the tracker item — rotate it regardless of
    // where the notification came from. Mirrors the PR gate's secret escape.
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "notifications@tasks.clickup.com",
        signalText: "the aws secret access key was committed and exposed in the repo",
        collabActivity: "mentioned_user",
      }),
      null,
    );
  });

  test("precedence: Alfred's own approval mail is alfred_approval, not tracker_owned", () => {
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "Alfred <alfred@example.com>",
        subject: "[medium] Alfred wants to send an email",
        signalText: "approve?",
      }),
      "alfred_approval",
    );
  });

  // cold_sender (rule 16b): a reply-shape ask from a cold human contact whose
  // only stake is "a person is waiting" — the HyperNexus cold-outreach shape.
  for (const category of ["awaiting_reply", "follow_up"] as const) {
    test(`cold_sender: a cold contact's ${category} ask with no intrinsic stake mints no todo`, () => {
      assert.equal(
        todoSuppressionReason({
          ...base,
          sender: "HyperNexus Sales Team <pelloni.robert@gmail.com>",
          subject: "Re: TormentNexus for 99Yash -- Thoughts?",
          signalText:
            "just following up on my previous note. worth a conversation? i'd love to share a quick demo.",
          category,
          isColdContact: true,
        }),
        "cold_sender",
      );
    });
  }

  test("KEEP: a cold contact is NOT gated outside the reply-shape lanes (e.g. action_needed)", () => {
    // A cold sender landing action_needed/payment/urgent is judged on that
    // category's intrinsic stake, not the person-waiting gate.
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "Unknown <cold@example.com>",
        signalText: "please rotate the exposed key",
        category: "action_needed",
        isColdContact: true,
      }),
      null,
    );
  });

  test("KEEP: a NON-cold (two-way) contact's direct ask is never cold_sender", () => {
    assert.equal(
      todoSuppressionReason({
        ...base,
        sender: "Priya <priya@acme.com>",
        signalText: "can you send me the signed sow?",
        category: "awaiting_reply",
        isColdContact: false,
      }),
      null,
    );
  });

  // A cold sender still earns a todo when the body carries a real intrinsic
  // stake (rule 16b): money owed, a hard deadline, or an exposed secret.
  for (const signalText of [
    "your invoice of $96.00 is past due",
    "can you confirm the contract before jun 30?",
    "the aws secret access key was committed and exposed",
    "your payment failed — update your card",
  ]) {
    test(`KEEP: cold contact with an intrinsic stake is not suppressed ("${signalText.slice(0, 24)}…")`, () => {
      assert.equal(
        todoSuppressionReason({
          ...base,
          sender: "Unknown <cold@example.com>",
          signalText,
          category: "awaiting_reply",
          isColdContact: true,
        }),
        null,
      );
    });
  }
});
