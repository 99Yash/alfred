/**
 * Live smoke/eval for the ADR-0042 triage subset.
 *
 *   $ cd apps/server
 *   $ pnpm exec tsx --env-file=.env src/scripts/smoke-triage-v2.ts
 *
 * Fixture-based: no Gmail credential, connected account, or ingested document
 * is required. This still uses real model calls through the metered wrappers,
 * so `.env` must contain the model/provider and DB settings used by normal
 * smoke scripts. Deepen receives fixture user context directly; the production
 * workflow currently uses the temporary DB reader and should move to
 * `system.read_user_context` when that runtime tool lands.
 */

import { flushLangfuse } from "@alfred/ai";
import { closeConnections } from "@alfred/db";
import { type TriageCategory } from "@alfred/contracts";
import {
  classifyEmail,
  type TriageClassification,
} from "@alfred/api/modules/triage/classify";
import {
  deepenTriageClassification,
  shouldDeepen,
  type DeepenDecision,
} from "@alfred/api/modules/triage/deepen";
import { extractSenderContext } from "@alfred/api/modules/triage/sender-context";
import { type TriageUserContext } from "@alfred/api/modules/triage/user-context";

interface SmokeDocument {
  id: string;
  title: string | null;
  content: string;
  authoredAt: Date | null;
  metadata: Record<string, unknown>;
}

interface LiveFixture {
  name: string;
  document: SmokeDocument;
  userContext?: TriageUserContext;
  expect: {
    categories: readonly TriageCategory[];
    wouldDeepen: boolean;
    deepenExecuted: boolean;
    shadowOnly: boolean;
    deepenReason?: DeepenDecision["reason"];
  };
}

interface RouteFixture {
  name: string;
  classification: TriageClassification;
  senderAddress?: string | null;
  senderContext: ReturnType<typeof extractSenderContext>["context"];
  expect: DeepenDecision & { shadowOnly: boolean; deepenExecuted: boolean };
}

interface LiveResult {
  fixture: LiveFixture;
  cheap: TriageClassification;
  final: TriageClassification;
  decision: DeepenDecision;
  deepenExecuted: boolean;
  shadowOnly: boolean;
}

const DEFAULT_USER_CONTEXT: TriageUserContext = {
  profile: { name: "Yash", email: "yash@example.com" },
  activeIntegrations: [],
  confirmedFacts: [],
  preferences: [],
  entities: [],
  recentMemory: [],
};

const ALFRED_PROD_CONTEXT: TriageUserContext = {
  profile: { name: "Yash", email: "yash@example.com" },
  activeIntegrations: [{ provider: "sentry", accountLabel: "Alfred production" }],
  confirmedFacts: [
    {
      key: "project:alfred-prod",
      value: { name: "alfred-prod", role: "owner", critical: true },
      confidence: 0.97,
    },
    {
      key: "product:alfred",
      value: "Alfred is Yash's personal AI assistant product.",
      confidence: 0.94,
    },
  ],
  preferences: [{ key: "triage.critical_projects", value: ["alfred-prod"] }],
  entities: [
    {
      kind: "project",
      canonicalName: "alfred-prod",
      aliases: ["Alfred", "alfred"],
      metadata: { environments: ["production"], critical: true },
    },
  ],
  recentMemory: [
    {
      kind: "project_context",
      preview: "Yash is actively building Alfred; alfred-prod is the production service.",
    },
  ],
};

const NOW = new Date("2026-06-03T09:00:00.000Z");

const LIVE_FIXTURES: LiveFixture[] = [
  {
    name: "apple public developer conference is marketing",
    document: doc({
      id: "smoke-apple-wwdc",
      from: "Apple Developer <news@insideapple.apple.com>",
      subject: "See you next week.",
      labels: ["CATEGORY_PROMOTIONS", "INBOX"],
      body:
        "WWDC26 is almost here. Join us online for the keynote, sessions, labs, " +
        "and developer activities starting next week.\n\nUnsubscribe from Apple Developer news.",
    }),
    expect: route("marketing", { wouldDeepen: false }),
  },
  {
    name: "annual general meeting notice is fyi",
    document: doc({
      id: "smoke-agm-fyi",
      from: "National Securities Depository Limited <evoting@nsdl.com>",
      subject: "Sundram Fasteners Limited - 63rd Annual General Meeting and Annual Report",
      body:
        "Please find attached the Notice of the 63rd Annual General Meeting and Annual Report " +
        "for your information. The meeting will be held through video conferencing.",
    }),
    expect: route("fyi", { wouldDeepen: false }),
  },
  {
    name: "proxy voting deadline is action_needed",
    document: doc({
      id: "smoke-proxy-vote",
      from: "National Securities Depository Limited <evoting@nsdl.com>",
      subject: "Remote e-voting closes tomorrow - cast your vote",
      body:
        "Action required: please cast your vote before the remote e-voting deadline closes " +
        "tomorrow at 5 PM. Click the e-voting link to approve or reject the resolutions.",
    }),
    expect: route("action_needed", { wouldDeepen: false }),
  },
  {
    name: "coderabbit advisory review stays fyi",
    document: doc({
      id: "smoke-coderabbit-advisory",
      from: "CodeRabbit <noreply@github.com>",
      subject: "[alfred] CodeRabbit review on PR #74",
      body:
        "**coderabbitai** commented on this pull request.\n\n" +
        "Consider extracting this helper into a smaller function. This is a readability suggestion.",
    }),
    expect: route("fyi", { wouldDeepen: false }),
  },
  {
    name: "coderabbit exposed secret escalates",
    document: doc({
      id: "smoke-coderabbit-secret",
      from: "CodeRabbit <noreply@github.com>",
      subject: "[alfred] CodeRabbit review on PR #75",
      body:
        "**coderabbitai** commented on this pull request.\n\n" +
        "A private API key is committed in this PR and appears exposed. Rotate the token today.",
    }),
    expect: route("urgent", { wouldDeepen: false }),
  },
  {
    name: "subscribed editorial digest is newsletter",
    document: doc({
      id: "smoke-newsletter",
      from: "The Pragmatic Engineer <newsletter@pragmaticengineer.com>",
      subject: "The Pragmatic Engineer weekly digest",
      body:
        "This week's issue: engineering strategy, platform teams, and production lessons. " +
        "You are receiving this newsletter because you subscribed. Unsubscribe anytime.",
    }),
    expect: route("newsletter", { wouldDeepen: false }),
  },
  {
    name: "personal reschedule thread is meeting",
    document: doc({
      id: "smoke-meeting",
      from: "Ada Lovelace <ada@example.com>",
      subject: "Design review moved to 3pm - can you attend?",
      body:
        "The design review moved from 2pm to 3pm today. Can you still attend? " +
        "I updated the agenda with the API migration notes.",
    }),
    expect: route("meeting", {
      wouldDeepen: false,
    }),
  },
  {
    name: "fresh human ask is awaiting_reply",
    document: doc({
      id: "smoke-awaiting-reply",
      from: "Grace Hopper <grace@example.com>",
      subject: "Question about Q3 numbers",
      body: "Could you send me the Q3 revenue breakdown when you have a chance?",
    }),
    expect: route("awaiting_reply", {
      wouldDeepen: true,
      deepenReason: "unknown_human",
      shadowOnly: true,
    }),
  },
  {
    name: "relevant sentry production spike deepens to urgent",
    document: doc({
      id: "smoke-sentry-prod",
      from: "Sentry <noreply@sentry.io>",
      subject: "[alfred-prod] Errors spiking: TypeError in /api/agent",
      body:
        "Project: alfred-prod\nEnvironment: production\n" +
        "1,248 events in the last 10 minutes. Users are seeing HTTP 500 responses. " +
        "First seen 4 minutes ago. Assigned to you.",
    }),
    userContext: ALFRED_PROD_CONTEXT,
    expect: route("urgent", {
      wouldDeepen: true,
      deepenReason: "severity_suspect_bot",
      deepenExecuted: true,
    }),
  },
  {
    name: "irrelevant resolved sentry alert deepens away from urgency",
    document: doc({
      id: "smoke-sentry-irrelevant",
      from: "Sentry <noreply@sentry.io>",
      subject: "[demo-app] Resolved: TypeError in staging",
      body:
        "Project: demo-app\nEnvironment: staging\n" +
        "Status: resolved. The issue had 2 events yesterday and has not recurred.",
    }),
    userContext: ALFRED_PROD_CONTEXT,
    expect: route(["done", "fyi"], {
      wouldDeepen: true,
      deepenReason: "severity_suspect_bot",
      deepenExecuted: true,
    }),
  },
];

const ROUTE_FIXTURES: RouteFixture[] = [
  {
    name: "low confidence is shadow only",
    classification: classification("meeting", 0.62),
    senderContext: { fromKind: "unknown", effectiveAuthor: "unknown" },
    expect: {
      mode: "shadow",
      reason: "low_confidence",
      shadowOnly: true,
      deepenExecuted: false,
    },
  },
  {
    name: "important unknown human is shadow only",
    classification: classification("action_needed", 0.86),
    senderAddress: "newfounder@example.com",
    senderContext: { fromKind: "person", effectiveAuthor: "person" },
    expect: {
      mode: "shadow",
      reason: "unknown_human",
      shadowOnly: true,
      deepenExecuted: false,
    },
  },
];

async function main() {
  const failures: string[] = [];
  console.log(`[smoke-triage-v2] live fixtures: ${LIVE_FIXTURES.length}`);

  for (const fixture of LIVE_FIXTURES) {
    try {
      const result = await runLiveFixture(fixture);
      const errors = validateLiveResult(result);
      if (errors.length === 0) {
        console.log(
          `[pass] ${fixture.name}: cheap=${result.cheap.category}/${result.cheap.confidence.toFixed(2)} ` +
            `final=${result.final.category}/${result.final.confidence.toFixed(2)} ` +
            `deepen=${result.decision.mode}`,
        );
      } else {
        failures.push(...errors.map((err) => `${fixture.name}: ${err}`));
        console.error(
          `[fail] ${fixture.name}: cheap=${result.cheap.category}/${result.cheap.confidence.toFixed(2)} ` +
            `final=${result.final.category}/${result.final.confidence.toFixed(2)} ` +
            `deepen=${result.decision.mode}`,
        );
        for (const err of errors) console.error(`    ${err}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${fixture.name}: threw ${msg}`);
      console.error(`[fail] ${fixture.name}: threw ${msg}`);
    }
  }

  console.log(`\n[smoke-triage-v2] route-only fixtures: ${ROUTE_FIXTURES.length}`);
  for (const fixture of ROUTE_FIXTURES) {
    const decision = shouldDeepen({
      classification: fixture.classification,
      senderContext: fixture.senderContext,
      senderAddress: fixture.senderAddress,
    });
    const shadowOnly = decision.mode === "shadow";
    const errors = validateRouteResult(fixture, decision, shadowOnly);
    if (errors.length === 0) {
      console.log(`[pass] ${fixture.name}: mode=${decision.mode} reason=${decision.reason ?? "none"}`);
    } else {
      failures.push(...errors.map((err) => `${fixture.name}: ${err}`));
      console.error(
        `[fail] ${fixture.name}: mode=${decision.mode} reason=${decision.reason ?? "none"}`,
      );
      for (const err of errors) console.error(`    ${err}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n[smoke-triage-v2] FAIL: ${failures.length} assertion(s) failed`);
    process.exitCode = 1;
    return;
  }

  console.log("\n[smoke-triage-v2] PASS");
}

async function runLiveFixture(fixture: LiveFixture): Promise<LiveResult> {
  const sender = extractSenderContext({
    fromHeader: metadataString(fixture.document.metadata, "from"),
    subject: fixture.document.title,
    body: fixture.document.content,
  });

  const cheapResult = await classifyEmail({
    document: fixture.document,
    senderContext: sender.context,
    idempotencyKey: `smoke-triage-v2:${fixture.document.id}:classify`,
  });
  const cheap = cheapResult.classification;
  const decision = shouldDeepen({
    classification: cheap,
    senderContext: sender.context,
    senderAddress: sender.senderAddress,
  });

  let final = cheap;
  let deepenExecuted = false;
  if (decision.mode === "execute") {
    const deepened = await deepenTriageClassification({
      document: fixture.document,
      classification: cheap,
      senderContext: sender.context,
      userContext: fixture.userContext ?? DEFAULT_USER_CONTEXT,
      idempotencyKey: `smoke-triage-v2:${fixture.document.id}:deepen`,
    });
    final = deepened.classification;
    deepenExecuted = true;
  }

  return {
    fixture,
    cheap,
    final,
    decision,
    deepenExecuted,
    shadowOnly: decision.mode === "shadow",
  };
}

function validateLiveResult(result: LiveResult): string[] {
  const errors: string[] = [];
  const { fixture, final, decision, deepenExecuted, shadowOnly } = result;
  const expected = fixture.expect;
  if (!expected.categories.includes(final.category)) {
    errors.push(`category: want ${expected.categories.join(" | ")}, got ${final.category}`);
  }
  const wouldDeepen = decision.mode !== "skip";
  if (wouldDeepen !== expected.wouldDeepen) {
    errors.push(`wouldDeepen: want ${String(expected.wouldDeepen)}, got ${String(wouldDeepen)}`);
  }
  if (deepenExecuted !== expected.deepenExecuted) {
    errors.push(
      `deepenExecuted: want ${String(expected.deepenExecuted)}, got ${String(deepenExecuted)}`,
    );
  }
  if (shadowOnly !== expected.shadowOnly) {
    errors.push(`shadowOnly: want ${String(expected.shadowOnly)}, got ${String(shadowOnly)}`);
  }
  if (expected.deepenReason !== undefined && decision.reason !== expected.deepenReason) {
    errors.push(
      `deepenReason: want ${expected.deepenReason}, got ${String(decision.reason ?? "none")}`,
    );
  }
  return errors;
}

function validateRouteResult(
  fixture: RouteFixture,
  decision: DeepenDecision,
  shadowOnly: boolean,
): string[] {
  const errors: string[] = [];
  if (decision.mode !== fixture.expect.mode) {
    errors.push(`mode: want ${fixture.expect.mode}, got ${decision.mode}`);
  }
  if (decision.reason !== fixture.expect.reason) {
    errors.push(
      `reason: want ${String(fixture.expect.reason ?? "none")}, got ${String(decision.reason ?? "none")}`,
    );
  }
  if (shadowOnly !== fixture.expect.shadowOnly) {
    errors.push(`shadowOnly: want ${String(fixture.expect.shadowOnly)}, got ${String(shadowOnly)}`);
  }
  if (fixture.expect.deepenExecuted) {
    errors.push("route-only fixture cannot execute deepen");
  }
  return errors;
}

function doc(args: {
  id: string;
  from: string;
  subject: string;
  body: string;
  labels?: string[];
}): SmokeDocument {
  const snippet = args.body.slice(0, 220);
  return {
    id: args.id,
    title: args.subject,
    content: args.body,
    authoredAt: NOW,
    metadata: {
      from: args.from,
      to: "Yash <yash@example.com>",
      snippet,
      labelIds: args.labels ?? ["INBOX"],
    },
  };
}

function route(
  categories: TriageCategory | readonly TriageCategory[],
  args: {
    wouldDeepen: boolean;
    deepenReason?: DeepenDecision["reason"];
    deepenExecuted?: boolean;
    shadowOnly?: boolean;
  },
): LiveFixture["expect"] {
  const expectedCategories = Array.isArray(categories) ? categories : [categories];
  return {
    categories: expectedCategories,
    wouldDeepen: args.wouldDeepen,
    deepenExecuted: args.deepenExecuted ?? false,
    shadowOnly: args.shadowOnly ?? false,
    deepenReason: args.deepenReason,
  };
}

function classification(category: TriageCategory, confidence: number): TriageClassification {
  return { category, confidence, rationale: "route fixture" };
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

main()
  .catch((err) => {
    console.error("[smoke-triage-v2] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await flushLangfuse().catch(() => {});
    await closeConnections().catch(() => {});
  });
