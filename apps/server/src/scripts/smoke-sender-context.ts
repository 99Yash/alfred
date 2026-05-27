/**
 * Smoke for ADR-0042 phase 3a — deterministic sender-context extraction.
 *
 *   $ pnpm tsx src/scripts/smoke-sender-context.ts
 *
 * Pure-function fixtures; no DB / LLM / network. Asserts the six canonical
 * cases from `docs/triage-briefing-v2-plan.md` plus a few edge cases that
 * exercise the parser dispatch table.
 *
 * Exits with code 1 on the first failure so CI gets a clear signal.
 */

// Deep import so the smoke doesn't pull `@alfred/api`'s entry barrel
// (which boots env, queues, and Elysia plugins at module load).
import { extractSenderContext } from "@alfred/api/modules/triage/sender-context";
import type { SenderContext } from "@alfred/contracts";

interface Fixture {
  name: string;
  fromHeader: string;
  subject: string;
  body: string;
  expect: {
    fromKind: SenderContext["fromKind"];
    effectiveAuthor: SenderContext["effectiveAuthor"];
    botSlug?: SenderContext["botSlug"];
    bodyActorKind?: NonNullable<SenderContext["bodyActor"]>["kind"];
    bodyActorName?: string;
    parserHit?: "github" | "calendar" | "linear" | null;
  };
}

const FIXTURES: Fixture[] = [
  {
    name: "github: coderabbit review comment",
    fromHeader: "CodeRabbit <noreply@github.com>",
    subject: "[acme/repo] PR #42",
    body:
      "**coderabbitai** commented on this pull request.\n\n" +
      "Nice. One nit: consider extracting the helper.",
    expect: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "coderabbit",
      bodyActorKind: "person", // no [bot] suffix in the visible body
      bodyActorName: "coderabbitai",
      parserHit: "github",
    },
  },
  {
    name: "github: dependabot with [bot] suffix",
    fromHeader: "dependabot[bot] <noreply@github.com>",
    subject: "[acme/repo] Bump foo from 1.0 to 1.1",
    body: "**dependabot[bot]** wants to merge 1 commit into main.",
    expect: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "dependabot",
      bodyActorKind: "bot",
      bodyActorName: "dependabot[bot]",
      parserHit: "github",
    },
  },
  {
    name: "google calendar: iCal organizer",
    fromHeader: "Google Calendar <calendar-notification@google.com>",
    subject: "Invitation: Sync @ 3pm",
    body:
      "You have been invited to the following event.\n\n" +
      "BEGIN:VCALENDAR\n" +
      'ORGANIZER;CN="Alice Smith":mailto:alice@example.com\n' +
      "END:VCALENDAR\n",
    expect: {
      fromKind: "service",
      effectiveAuthor: "person",
      bodyActorKind: "person",
      bodyActorName: "Alice Smith",
      parserHit: "calendar",
    },
  },
  {
    name: "linear: comment from named human",
    fromHeader: "Linear <notifications@linear.app>",
    subject: "Re: ENG-123",
    body: "Comment from Alice\n\nLooks good — shipping it.",
    expect: {
      fromKind: "service",
      effectiveAuthor: "person",
      bodyActorKind: "person",
      bodyActorName: "Alice",
      parserHit: "linear",
    },
  },
  {
    name: "sentry alert: severity-suspect bot",
    fromHeader: "Sentry <noreply@sentry.io>",
    subject: "[acme] New issue: TypeError in handler",
    body: "An issue was just created in your project.",
    expect: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "sentry",
      parserHit: null,
    },
  },
  {
    name: "plain person sender",
    fromHeader: "Alice Smith <alice@example.com>",
    subject: "Quick question",
    body: "Hey — got a minute?",
    expect: {
      fromKind: "person",
      effectiveAuthor: "person",
      parserHit: null,
    },
  },
  {
    name: "unknown service envelope (info@ on unknown domain)",
    fromHeader: "info@somerandomsaas.com",
    subject: "Welcome to RandomSaaS",
    body: "Thanks for signing up.",
    expect: {
      fromKind: "unknown",
      effectiveAuthor: "unknown",
      parserHit: null,
    },
  },
  {
    name: "stripe billing failure",
    fromHeader: "Stripe <no-reply@stripe.com>",
    subject: "Your payment failed",
    body: "We were unable to charge your card.",
    expect: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "stripe-billing",
      parserHit: null,
    },
  },
  {
    name: "google security sign-in alert",
    fromHeader: "Google <no-reply@accounts.google.com>",
    subject: "Sign-in attempt from a new device",
    body: "We noticed a new sign-in to your Google Account.",
    expect: {
      fromKind: "service",
      effectiveAuthor: "bot",
      botSlug: "google-security",
      parserHit: null,
    },
  },
];

let failed = 0;

for (const fx of FIXTURES) {
  const result = extractSenderContext({
    fromHeader: fx.fromHeader,
    subject: fx.subject,
    body: fx.body,
  });
  const errs: string[] = [];

  if (result.context.fromKind !== fx.expect.fromKind) {
    errs.push(`fromKind: want ${fx.expect.fromKind}, got ${result.context.fromKind}`);
  }
  if (result.context.effectiveAuthor !== fx.expect.effectiveAuthor) {
    errs.push(
      `effectiveAuthor: want ${fx.expect.effectiveAuthor}, got ${result.context.effectiveAuthor}`,
    );
  }
  if (fx.expect.botSlug !== undefined) {
    if (result.context.botSlug !== fx.expect.botSlug) {
      errs.push(`botSlug: want ${fx.expect.botSlug}, got ${String(result.context.botSlug)}`);
    }
  } else if (result.context.botSlug !== undefined) {
    errs.push(`botSlug: want undefined, got ${result.context.botSlug}`);
  }
  if (fx.expect.bodyActorKind !== undefined) {
    if (result.context.bodyActor?.kind !== fx.expect.bodyActorKind) {
      errs.push(
        `bodyActor.kind: want ${fx.expect.bodyActorKind}, got ${String(result.context.bodyActor?.kind)}`,
      );
    }
  }
  if (fx.expect.bodyActorName !== undefined) {
    if (result.context.bodyActor?.name !== fx.expect.bodyActorName) {
      errs.push(
        `bodyActor.name: want ${fx.expect.bodyActorName}, got ${String(result.context.bodyActor?.name)}`,
      );
    }
  }
  if (fx.expect.parserHit !== undefined && result.parserHit !== fx.expect.parserHit) {
    errs.push(`parserHit: want ${String(fx.expect.parserHit)}, got ${String(result.parserHit)}`);
  }

  if (errs.length === 0) {
    console.log(`✓ ${fx.name}`);
  } else {
    failed += 1;
    console.error(`✗ ${fx.name}`);
    for (const e of errs) console.error(`    ${e}`);
    console.error(`    context=${JSON.stringify(result.context)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} fixture(s) failed`);
  process.exit(1);
}
console.log(`\nall ${FIXTURES.length} fixtures green`);
