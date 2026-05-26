/**
 * Canonical triage category list. Lives in `@alfred/contracts` so the
 * web bundle can import it without pulling in the Node-only
 * `@alfred/integrations` package. `@alfred/integrations/google/labels`
 * re-exports `TRIAGE_CATEGORIES` and `TriageCategory` from here and adds
 * the integration-specific Gmail label-name mapping on top — there is
 * only one source of truth.
 */

import { z } from "zod";

export const TRIAGE_CATEGORIES = [
  "urgent",
  "action_needed",
  "follow_up",
  "awaiting_reply",
  "meeting",
  "fyi",
  "done",
  "payment",
  "newsletter",
  "marketing",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** Short display label for the rail chip. */
export const TRIAGE_DISPLAY: Record<TriageCategory, string> = {
  urgent: "Urgent",
  action_needed: "Action",
  follow_up: "Follow-up",
  awaiting_reply: "Awaiting",
  meeting: "Meeting",
  fyi: "FYI",
  done: "Done",
  payment: "Payment",
  newsletter: "Newsletter",
  marketing: "Marketing",
};

export function isTriageCategory(value: unknown): value is TriageCategory {
  return typeof value === "string" && (TRIAGE_CATEGORIES as readonly string[]).includes(value);
}

export const triageCategorySchema = z.enum(TRIAGE_CATEGORIES);

// ─── ADR-0042: SenderContext ──────────────────────────────────────────────

export const SENDER_KIND = ["person", "service", "unknown"] as const;
export type SenderKind = (typeof SENDER_KIND)[number];

export const EFFECTIVE_AUTHOR = ["bot", "person", "service", "unknown"] as const;
export type EffectiveAuthor = (typeof EFFECTIVE_AUTHOR)[number];

/**
 * Bot slug allowlist. Each slug names a recognized automated sender whose
 * envelope or body-actor pattern the `extract-sender-context` step can
 * identify deterministically. Grow this list from observed
 * `triage.sender_extraction` log evidence, never speculation.
 */
export const BOT_SLUGS = [
  "coderabbit",
  "copilot-review",
  "github-actions",
  "dependabot",
  "renovate",
  "vercel",
  "sentry",
  "stripe-billing",
  "google-security",
  "datadog",
] as const;
export type BotSlug = (typeof BOT_SLUGS)[number];

/**
 * Subset of `BOT_SLUGS` whose alerts CAN be same-day urgent. The classifier
 * escalates these to `deepen` even when the cheap prompt would have labelled
 * them `fyi`. Review-comment bots (CodeRabbit, Copilot, GitHub Actions,
 * Dependabot, Renovate) are deliberately excluded — advisory by default,
 * with rule 9a's security-advisory exception catching the rare severe case.
 */
export const SEVERITY_SUSPECT_BOTS: ReadonlySet<BotSlug> = new Set<BotSlug>([
  "sentry",
  "stripe-billing",
  "google-security",
  "vercel",
  "datadog",
]);

export interface SenderContext {
  fromKind: SenderKind;
  bodyActor?: {
    kind: "bot" | "person" | "unknown";
    name: string;
    handle?: string;
  };
  effectiveAuthor: EffectiveAuthor;
  botSlug?: BotSlug;
}

export const senderContextSchema: z.ZodType<SenderContext> = z.object({
  fromKind: z.enum(SENDER_KIND),
  bodyActor: z
    .object({
      kind: z.enum(["bot", "person", "unknown"]),
      name: z.string().min(1),
      handle: z.string().min(1).optional(),
    })
    .optional(),
  effectiveAuthor: z.enum(EFFECTIVE_AUTHOR),
  botSlug: z.enum(BOT_SLUGS).optional(),
});
