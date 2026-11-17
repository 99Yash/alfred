import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  parseGmailDocumentMetadata,
  parseIanaTimezone,
  type SenderContext,
} from "@alfred/contracts";
import { readMailFacts, type MailFacts } from "@alfred/assistant/knowledge/mail-facts";

import {
  classifyCallOptions,
  classifyEmail,
  normalizeClassifierOutput,
  SYSTEM_PROMPT,
  triageClassificationSchema,
  type ClassifyEmailArgs,
  type RunPass,
  type TriageClassification,
} from "@alfred/assistant/triage/classify";
import { applyFloorVerdict } from "@alfred/assistant/triage/floors/floor";
import type { Observations } from "@alfred/assistant/triage/observations";
import { applyOverrideFloor as overrideFloorVerdict } from "../../src/triage/floors/override";

// ---------------------------------------------------------------------------
// Override-floor harness. The wrapper runs the floor's verdict through
// `applyFloorVerdict`, as `applyFloors` does. Floor order and threading live in
// `floors.test.ts`.
// ---------------------------------------------------------------------------

function applyOverrideFloor(...args: Parameters<typeof overrideFloorVerdict>) {
  const audit = overrideFloorVerdict(...args);

  return {
    ...audit,
    classification: applyFloorVerdict(args[0], audit.verdict),
    forced: audit.verdict.kind === "escalate",
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function observations(overrides: Partial<Observations> = {}): Observations {
  return {
    persona: null,
    thread: { lastUserReplyAt: null, newestDirection: null, messageCount: 0, recentMessages: [] },
    knownContact: false,
    senderRelationship: null,
    senderRelationshipIsCold: false,
    senderKind: null,
    standingInstructions: null,
    userContext: null,
    userContextReadFailed: false,
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
    ...overrides,
  };
}

function classification(over: Partial<TriageClassification> = {}): TriageClassification {
  return { category: "fyi", confidence: 0.8, rationale: "because", ...over };
}

/** The sender context these tests were written against. */
const TEST_SENDER: SenderContext = { fromKind: "service", effectiveAuthor: "service" };

/** The reader over the test document (no stored message, so it reads the metadata). */
function factsFor(document: ClassifyEmailArgs["document"]): MailFacts {
  const facts = readMailFacts(
    { ...document, sourceId: document.id, sourceThreadId: null, accountId: null, raw: null },
    {
      timezone: parseIanaTimezone("UTC"),
      mailboxByAccountId: new Map(),
      userAddresses: new Set(),
      knownContacts: new Set(),
      ownReplies: [],
    },
  );

  return {
    ...facts,
    sender: { ...facts.sender, parse: { ...facts.sender.parse, context: TEST_SENDER } },
  };
}

function args(over: Partial<ClassifyEmailArgs> = {}): ClassifyEmailArgs {
  const document = over.document ?? {
    id: "doc_1",
    title: "Subject",
    content: "Body",
    authoredAt: null,
    metadata: parseGmailDocumentMetadata({}),
  };

  return {
    document,
    mailFacts: factsFor(document),
    observations: observations(),
    ...over,
  };
}

/** A canned model: one fixed output per pass, and a call count. */
function scriptedModel(first: TriageClassification) {
  let calls = 0;

  const runPass: RunPass = async () => {
    calls++;

    return first;
  };

  return { runPass, calls: () => calls };
}

// ---------------------------------------------------------------------------
// applyOverrideFloor
// ---------------------------------------------------------------------------

describe("applyOverrideFloor", () => {
  test("forces urgent on an exposed-secret body regardless of model output", () => {
    const r = applyOverrideFloor(
      classification({ category: "promo", confidence: 0.8 }),
      "a private api key was leaked in this commit and must be rotated",
    );

    assert.equal(r.classification.category, "urgent");
    assert.equal(r.forced, true);
    assert.match(r.classification.rationale, /override floor/i);
    // Forced urgent raises confidence to at least 0.85; the UI shows it.
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
    // `credential` alone does not force urgent, so architecture talk is not force-tagged.
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
// classifyEmail orchestration (injected model, no live LLM)
// ---------------------------------------------------------------------------

describe("classifyEmail", () => {
  test("renders subject and body as distinct evidence without sender inference", async () => {
    let prompt = "";

    const runPass: RunPass = async (input) => {
      prompt = input.prompt;

      return classification();
    };

    await classifyEmail(
      args({
        document: {
          id: "doc_clickup_prompt",
          title: "Fix login redirect loop",
          content:
            "From: Oliv AI <notifications@tasks.clickup.com>\n" +
            "To: yash.k@oliv.ai\n" +
            "Subject: Fix login redirect loop\n\n" +
            "Brain: Done. Created [Fix login redirect loop] in the backlog.",
          authoredAt: null,
          metadata: parseGmailDocumentMetadata({
            from: "Oliv AI <notifications@tasks.clickup.com>",
            to: "yash.k@oliv.ai",
          }),
        },
        observations: observations({
          thread: {
            lastUserReplyAt: null,
            newestDirection: "received",
            messageCount: 1,
            recentMessages: [
              {
                direction: "received",
                authoredAt: null,
                snippet: "Priya assigned you this task and asked you to fix it.",
              },
            ],
          },
        }),
        runPass,
      }),
    );

    assert.match(
      prompt,
      /=== Subject — context, not proof of user ownership ===\nFix login redirect loop/,
    );
    assert.match(
      prompt,
      /=== Body ===\nBrain: Done\. Created \[Fix login redirect loop\] in the backlog\./,
    );
    assert.match(
      prompt,
      /=== Earlier thread context — use this to decide loop state and ownership ===[\s\S]*Priya assigned you this task[\s\S]*Final loop-state check: if the earlier context shows an unanswered user-owned assignment or ask, you MUST keep action or reply\. A passive current message cannot demote that open loop\./,
    );
    assert.doesNotMatch(prompt, /Tracker notification|Interpretation note/);
    assert.equal(prompt.match(/Priya assigned you this task/g)?.length ?? 0, 1);
    assert.equal(prompt.match(/Subject: Fix login redirect loop/g)?.length ?? 0, 0);
    assert.equal(prompt.match(/From: Oliv AI/g)?.length ?? 0, 1);
  });

  test("strips stored envelope headers from an ordinary email body", async () => {
    let prompt = "";

    const runPass: RunPass = async (input) => {
      prompt = input.prompt;

      return classification();
    };

    await classifyEmail(
      args({
        document: {
          id: "doc_person_prompt",
          title: "Proposal update",
          content:
            "From: Priya <priya@acme.com>\n" +
            "To: yash@example.com\n" +
            "Subject: Proposal update\n\n" +
            "Can you send the revised proposal?",
          authoredAt: null,
          metadata: parseGmailDocumentMetadata({
            from: "Priya <priya@acme.com>",
            to: "yash@example.com",
          }),
        },
        observations: observations({
          thread: {
            lastUserReplyAt: new Date("2026-06-10T11:30:00Z"),
            newestDirection: "sent",
            messageCount: 1,
            recentMessages: [
              {
                direction: "sent",
                authoredAt: new Date("2026-06-10T11:30:00Z"),
                snippet: "I sent the revised proposal this morning.",
              },
            ],
          },
        }),
        runPass,
      }),
    );

    assert.match(prompt, /=== Subject — context, not proof of user ownership ===\nProposal update/);
    assert.match(prompt, /=== Body ===\nCan you send the revised proposal\?/);
    assert.match(
      prompt,
      /Can you send the revised proposal\?[\s\S]*=== Earlier thread context — use this to decide loop state and ownership ===[\s\S]*I sent the revised proposal this morning\./,
    );
    assert.equal(prompt.match(/I sent the revised proposal/g)?.length ?? 0, 1);
    assert.equal(prompt.match(/From: Priya/g)?.length ?? 0, 1);
  });

  test("preserves a header-shaped first line in the real email body", async () => {
    let prompt = "";

    const runPass: RunPass = async (input) => {
      prompt = input.prompt;

      return classification();
    };

    await classifyEmail(
      args({
        document: {
          id: "doc_date_body",
          title: "Planning details",
          content:
            "From: Priya <priya@acme.com>\n" +
            "To: yash@example.com\n" +
            "Subject: Planning details\n\n" +
            "Date: September 1\n" +
            "Time: 10:00\n" +
            "Location: Room 4",
          authoredAt: null,
          metadata: parseGmailDocumentMetadata({
            from: "Priya <priya@acme.com>",
            to: "yash@example.com",
          }),
        },
        runPass,
      }),
    );

    assert.match(prompt, /=== Body ===\nDate: September 1\nTime: 10:00\nLocation: Room 4/);
  });

  test("acceptance: prior-heavy promo sender + credential-exposure body still lands urgent", async () => {
    // The model says promo, but the body exposes a secret.
    const model = scriptedModel(classification({ category: "promo", confidence: 0.95 }));

    const result = await classifyEmail(
      args({
        document: {
          id: "doc_secret",
          title: "Weekly digest",
          content: "...also your private api key was leaked in our config repo, rotate it now",
          authoredAt: null,
          metadata: parseGmailDocumentMetadata({}),
        },
        observations: observations(),
        runPass: model.runPass,
      }),
    );

    assert.equal(result.classification.category, "urgent");
    assert.equal(result.audit.floors.override.verdict.kind, "escalate");
    assert.match(result.model, /\+floor$/);
  });

  test("acceptance: self-initiated magic link is fyi, single pass", async () => {
    // No exposure verb and no security keyword, so fyi survives without a second pass.
    const model = scriptedModel(classification({ category: "fyi", confidence: 0.9 }));

    const result = await classifyEmail(
      args({
        document: {
          id: "doc_magic",
          title: "Sign in to Anthropic",
          content: "Click to sign in. Your login code is 123456. Verify your email address.",
          authoredAt: null,
          metadata: parseGmailDocumentMetadata({}),
        },
        runPass: model.runPass,
      }),
    );

    assert.equal(result.classification.category, "fyi");
    assert.equal(result.audit.floors.override.verdict.kind, "keep");
    assert.equal(result.audit.conflict, null);
    assert.equal(model.calls(), 1); // no second pass
  });

  test("no conflict → single pass, audit reflects no second pass or floor", async () => {
    const model = scriptedModel(classification({ category: "promo" }));

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
    assert.equal(result.audit.floors.override.matched, false);
    assert.equal(result.audit.floors.override.verdict.kind, "keep");
    assert.equal(result.classification.category, "promo");
    assert.equal(result.model, "injected");
  });
});

// ---------------------------------------------------------------------------
// Output normalization at the classifier boundary
// ---------------------------------------------------------------------------

describe("normalizeClassifierOutput", () => {
  test("normalizes omitted collabActivity to null at the classifier boundary", () => {
    const output = normalizeClassifierOutput<TriageClassification>({
      category: "fyi",
      confidence: 1.4,
      rationale: "not a collaboration notification",
    });

    assert.equal(output.confidence, 1);
    assert.equal(output.collabActivity, null);
  });
});

// ---------------------------------------------------------------------------
// Hedge wiring (#436)
// ---------------------------------------------------------------------------

/**
 * `classifyCallOptions` must pass the abort signal to the provider.
 * If it breaks, nothing errors; the loser just bills a full second call.
 */
describe("classifyCallOptions", () => {
  const call = (signal: AbortSignal) =>
    classifyCallOptions({
      model: "gemini-2.5-flash-lite",
      instructions: SYSTEM_PROMPT,
      prompt: "an email",
      signal,
      maxRetries: undefined,
      withInstructionMatches: false,
    });

  test("forwards the hedge attempt's signal to the provider call", () => {
    const controller = new AbortController();
    const options = call(controller.signal);

    assert.equal(options.abortSignal, controller.signal, "the loser can only be cancelled by this");

    controller.abort();
    assert.equal(options.abortSignal.aborted, true);
  });

  test("both draws are interchangeable — the property first-wins rests on", () => {
    // Temperature 0 makes both draws equal, so the first one costs no precision.
    const options = call(new AbortController().signal);
    assert.equal(options.temperature, 0);
    assert.equal(options.schema, triageClassificationSchema);
    assert.equal(options.maxOutputTokens, 400);
    assert.deepEqual(options.timeout, { totalMs: 30_000 });
  });

  test("maxRetries stays absent in production and set for the eval", () => {
    assert.equal("maxRetries" in call(new AbortController().signal), false);

    const evalOptions = classifyCallOptions({
      model: "gemini-2.5-flash-lite",
      instructions: SYSTEM_PROMPT,
      prompt: "an email",
      signal: new AbortController().signal,
      maxRetries: 1,
      withInstructionMatches: false,
    });

    assert.equal(evalOptions.maxRetries, 1);
  });
});
