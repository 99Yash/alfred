/**
 * Standing instructions — the durable, behavior-changing directives the user
 * states in plain language ("stop emailing me about Ben Book"). ADR-0056/0057
 * governance; ADR-0058 store (a `user_facts` row, `key="standing_instruction"`,
 * structured JSONB `value` — no new table). Zero Node deps — safe to import from
 * `apps/web`, `packages/db` (`.$type<T>()`), `packages/assistant`, `packages/sync`.
 *
 * The enums + the `value` schema live here so the `user_facts` column type, the
 * `system.remember` write tool, and the triage/briefing readers all agree by
 * construction. The load-bearing closed enum is `SUPPRESSION_EFFECTS`: each
 * consumer branches on a registered effect (never re-derives intent from the
 * product-label `surface`), the way `TOOL_LABELS` centralizes tool copy. A new
 * consumer registers its effect here first.
 *
 * Scope today = a sender address or a sender domain (the "Ben Book" loop, see
 * docs/plans/long-term-memory-v1.md). The target is a DISCRIMINATED UNION on
 * `kind`, so each kind carries only the field it matches on and a reader must
 * narrow before it reads one. Topic-scope targets, subdomain matching, and
 * non-suppress actions stay deferred variants of the same shape.
 */

import { z } from "zod";
import { domainSchema, emailDomain } from "./domain";

/** Canonical `user_facts.key` for every standing instruction. */
export const STANDING_INSTRUCTION_KEY = "standing_instruction";

/**
 * Bumped when the `value` shape changes incompatibly, so the reader can branch
 * without ambiguity. Resolve-at-write: writers stamp the current version.
 */
export const STANDING_INSTRUCTION_SCHEMA_VERSION = 1 as const;

// ─── Action ──────────────────────────────────────────────────────────────

/** `suppress` — stop surfacing/reminding. Only action at v1; forward-compat. */
export const STANDING_INSTRUCTION_ACTIONS = ["suppress"] as const;

export type StandingInstructionAction = (typeof STANDING_INSTRUCTION_ACTIONS)[number];

export const standingInstructionActionSchema = z.enum(STANDING_INSTRUCTION_ACTIONS);

// ─── Surface (product/display label — NOT the operational contract) ─────────

/**
 * The human-readable intent shown in UI and used to phrase `directive`.
 * Consumers must NOT branch on this — they branch on `effects`. `open_loop` =
 * suppress the nag/todo/briefing surfacing, not the email's existence.
 */
export const STANDING_INSTRUCTION_SURFACES = ["open_loop"] as const;

export type StandingInstructionSurface = (typeof STANDING_INSTRUCTION_SURFACES)[number];

export const standingInstructionSurfaceSchema = z.enum(STANDING_INSTRUCTION_SURFACES);

// ─── Effects (the closed operational contract consumers branch on) ──────────

/**
 * The concrete, registered effects of a standing instruction.
 *
 * LEGACY WRITE SNAPSHOT — readers must NOT branch on the stored array.
 * Every writer stores the full registry (`effects: [...SUPPRESSION_EFFECTS]`)
 * and no writer ever picks a subset, so the column encodes the registry
 * length at write time, never a decision the user made. Membership is
 * derived at read time: any active sender suppression binds its sender for
 * every consumer. A fifth effect therefore needs no backfill, no repair
 * function, and no per-row widening — it reads the same rows.
 *
 * `SUPPRESSION_EFFECTS` remains as the closed registry new consumers register
 * in (and writers stamp for schema compat), but it is not the operational
 * contract. The operational contract is "an active suppression exists for
 * this sender".
 *
 * `block_todo_suggestion`     — triage `classify` mints no `todoSuggestion` for a matching email.
 * `exclude_briefing_priority` — briefing `gather` drops the match from the priority buckets.
 * `block_reply_draft`         — the reply-drafting gate returns `no_draft` for a matching sender
 *                               (ADR-0098).
 * `deprioritize_triage_category` — triage `classify` weighs the instruction as a
 *                               category prior when it picks the label. This is the ONLY
 *                               effect that can change the Gmail label the user sees. It is
 *                               a PRIOR, not a floor: the directives this reads say "routine
 *                               notices are low priority" AND "a genuinely urgent one may
 *                               still surface", so only a model can separate the two. A
 *                               deterministic demotion would honor the first clause by
 *                               breaking the second. Implements ADR-0066 signal 3
 *                               (standing instructions extended to the category);
 *                               rendered per ADR-0051 §5's anti-brittleness line — a
 *                               deterministic fact fed as a hint, never a rewrite.
 */
export const SUPPRESSION_EFFECTS = [
  "block_todo_suggestion",
  "exclude_briefing_priority",
  "block_reply_draft",
  "deprioritize_triage_category",
] as const;

export type SuppressionEffect = (typeof SUPPRESSION_EFFECTS)[number];

export const suppressionEffectSchema = z.enum(SUPPRESSION_EFFECTS);

// ─── Target ────────────────────────────────────────────────────────────────

/**
 * What an instruction binds to.
 *
 * `sender_email` — one sender address.
 * `sender_domain` — every address at one domain. The user's words often name a
 * class ("all investment senders"), and an address list cannot grow: a sender
 * the user had not received mail from at capture time never matches. A domain
 * target covers every mailbox at that host, including future ones.
 */
export const STANDING_INSTRUCTION_TARGET_KINDS = ["sender_email", "sender_domain"] as const;

export type StandingInstructionTargetKind = (typeof STANDING_INSTRUCTION_TARGET_KINDS)[number];

export const standingInstructionTargetKindSchema = z.enum(STANDING_INSTRUCTION_TARGET_KINDS);

/**
 * Resolve-at-write: the match key is canonical by the time it is stored, so a
 * reader matches on it directly and never re-normalizes. The `sender_email` arm
 * **normalizes** (trim → lowercase) and **validates** email shape; the
 * `sender_domain` arm does the same for a bare DNS domain through
 * {@link domainSchema}. Both arms were one flat object before `sender_domain`
 * existed; the union makes an address-less `sender_email` target and a
 * domain-less `sender_domain` target unrepresentable, and it forces every
 * reader to narrow on `kind` before it reads a match key.
 *
 * `accountId` is `null` = cross-account (suppress the sender, not one mailbox);
 * a future per-account scope sets it without a reshape.
 *
 * The `sender_email` arm keeps every field rule it had at v1, so a stored row
 * parses unchanged and {@link STANDING_INSTRUCTION_SCHEMA_VERSION} stays 1.
 */
export const standingInstructionTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sender_email"),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    label: z.string().nullish(),
    accountId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("sender_domain"),
    domain: domainSchema,
    label: z.string().nullish(),
    accountId: z.string().nullable(),
  }),
]);

export type StandingInstructionTarget = z.infer<typeof standingInstructionTargetSchema>;

/**
 * The stable identity of a target — `"sender_email:a@b.com"` or
 * `"sender_domain:b.com"`. Two targets name the same thing when their keys are
 * equal, so a duplicate check and an advisory-lock key both read this instead
 * of reaching for an arm-specific field.
 */
export function standingInstructionTargetKey(target: StandingInstructionTarget): string {
  switch (target.kind) {
    case "sender_email":
      return `${target.kind}:${target.email}`;
    case "sender_domain":
      return `${target.kind}:${target.domain}`;
    default: {
      const exhaustive: never = target;

      return String(exhaustive);
    }
  }
}

/**
 * THE match rule: does this target cover this sender? One place decides it, and
 * it sits beside the union so the compiler ties the two together — a third
 * target kind fails the exhaustive guard until it has a match rule.
 *
 * The parameter is the sender ADDRESS alone, and the `sender_domain` arm derives
 * the domain from it through {@link emailDomain}. A caller cannot hand in a
 * domain that does not belong to the address, because a caller never hands in a
 * domain at all — the one unrepresentable-state rule this function needs.
 * `senderEmail` is expected normalized (trimmed, lowercased); `emailDomain`
 * normalizes again, so a stray capital only affects the `sender_email` arm.
 *
 * A string comparison alone computes the answer. No model call, no network
 * call, no database read: the triage hot path calls this per message.
 *
 * `sender_domain` matches an EXACT domain, never a subdomain. A correct suffix
 * rule needs a public-suffix list, and without one a target of `co.in` would
 * suppress a whole country's mail. Exact equality fails safe: a target that is
 * too wide matches nothing.
 *
 * `accountId` is NOT read here. It scopes the instruction to a mailbox, which
 * is the caller's question, not the target's.
 */
export function targetMatchesSender(
  target: StandingInstructionTarget,
  senderEmail: string,
): boolean {
  switch (target.kind) {
    case "sender_email":
      return target.email === senderEmail;
    case "sender_domain": {
      const senderDomain = emailDomain(senderEmail);

      return senderDomain !== null && target.domain === senderDomain;
    }

    default: {
      const exhaustive: never = target;
      void exhaustive;

      return false;
    }
  }
}

/**
 * How specific a target is — a higher number wins. ADR-0060 micro-decision 8
 * fixes the apply-time precedence: when several instructions match one sender,
 * the most specific target wins and recency only breaks a tie. The order the
 * ADR names is `sender_email`/`person` > `sender_domain` > `category` >
 * `topic`.
 *
 * The rule was unreachable while `sender_email` was the only kind. It became
 * reachable with `sender_domain`, because the user can pin one address inside a
 * domain the same user already muted, and both rows then match the same sender.
 * Without this rank the newer row wins, so a domain mute written after the pin
 * defeats the pin.
 *
 * The numbers are spaced, not consecutive: `category` and `topic` are deferred
 * kinds that rank BELOW `sender_domain`, so a later kind takes a free number
 * and renumbers nothing.
 *
 * This lives beside {@link standingInstructionTargetKey} and
 * {@link targetMatchesSender} so the exhaustive guard forces a third kind to
 * state its rank before it compiles.
 */
export function standingInstructionTargetSpecificity(target: StandingInstructionTarget): number {
  switch (target.kind) {
    case "sender_email":
      return 40;
    case "sender_domain":
      return 30;

    default: {
      const exhaustive: never = target;
      void exhaustive;

      return 0;
    }
  }
}

// ─── The `user_facts.value` shape ───────────────────────────────────────────

/**
 * Single-line, bounded prose for anything interpolated into a `===` sectioned
 * prompt. A multi-line value forges a sibling section above the derived
 * signals, so newlines are rejected at the schema (not stripped — stripping
 * would silently rewrite the user's words).
 */
const singleLineProse = z
  .string()
  .min(1)
  .max(1_000)
  .refine((s) => !/[\r\n]/.test(s), {
    message: "must be single-line",
  });

export const standingInstructionValueSchema = z.object({
  schemaVersion: z.literal(STANDING_INSTRUCTION_SCHEMA_VERSION),
  action: standingInstructionActionSchema,
  surface: standingInstructionSurfaceSchema,
  target: standingInstructionTargetSchema,
  /** The operational contract. Consumers branch on membership here. */
  effects: z.array(suppressionEffectSchema).min(1),
  /** Resolved, prompt-ready sentence a prose consumer can drop in verbatim. */
  directive: singleLineProse,
  /** Verbatim user words — provenance/UI only. No pipeline ever parses this. */
  phrasing: singleLineProse,
});

export type StandingInstructionValue = z.infer<typeof standingInstructionValueSchema>;

/**
 * Legacy membership probe. Readers must NOT call this on the hot path:
 * membership is derived at read time (an active suppression binds its sender
 * for every consumer), so a stored-array check reintroduces the snapshot bug
 * this registry replaced. Kept for tooling that inspects a raw row.
 */
export function hasSuppressionEffect(
  value: StandingInstructionValue,
  effect: SuppressionEffect,
): boolean {
  return value.effects.includes(effect);
}
