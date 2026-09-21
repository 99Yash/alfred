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
import { domainSchema, emailDomain, normalizeEmailAddress } from "./domain";

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
 * A sender address validated through {@link normalizeEmailAddress} — the same
 * acceptance set as the old trim → lowercase → `z.email()` chain, plus `<>`
 * and `mailto:` tolerance. The stored match key is canonical by construction.
 */
const senderEmailAddressSchema: z.ZodType<string, string> = z
  .string()
  .transform((value) => normalizeEmailAddress(value))
  .refine((value): value is string => value !== null, {
    message: "must be a valid email address",
  });

/**
 * Resolve-at-write: the match key is canonical by the time it is stored, so a
 * reader matches on it directly and never re-normalizes. The `sender_email` arm
 * validates through {@link normalizeEmailAddress} and the `sender_domain` arm
 * through {@link domainSchema}. Both arms were one flat object before
 * `sender_domain` existed; the union makes an address-less `sender_email`
 * target and a domain-less `sender_domain` target unrepresentable, and it
 * forces every reader to narrow on `kind` before it reads a match key.
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
    email: senderEmailAddressSchema,
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
 * What the mint boundary already decided, before the target is built. The
 * corporate-domain gate (`classifyEmailDomain`) stays at the mint boundary in
 * the assistant — it lives in `identity-affiliation.ts`, which this module
 * must not import — so the constructor takes the already-gated
 * `domain: string | null` and only picks the arm. `email` is the normalized
 * sender address.
 */
export interface BuildStandingInstructionTargetInput {
  email: string;
  domain: string | null;
  label: string | null;
  accountId: string | null;
}

/**
 * THE constructor: build the target this mint stores. It sits beside the
 * union with the key, the match rule, and the rank, so building a target is
 * a fourth union-adjacent operation — a third kind has no input channel here
 * until this body names it.
 */
export function buildStandingInstructionTarget(
  input: BuildStandingInstructionTargetInput,
): StandingInstructionTarget {
  if (input.domain !== null) {
    return {
      kind: "sender_domain",
      domain: input.domain,
      label: input.label,
      accountId: input.accountId,
    };
  }

  return {
    kind: "sender_email",
    email: input.email,
    label: input.label,
    accountId: input.accountId,
  };
}

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
      void exhaustive;

      throw new Error("unreachable standing-instruction target kind");
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
 * `senderEmail` is expected in {@link normalizeEmailAddress} spelling;
 * `emailDomain` normalizes again, so a stray capital only affects the
 * `sender_email` arm.
 *
 * A string comparison alone computes the answer. No model call, no network
 * call, no database read: the triage hot path calls this per message.
 *
 * `sender_domain` matches an EXACT domain, never a subdomain. A correct suffix
 * rule needs a public-suffix list, and without one a target of `co.in` would
 * suppress a whole country's mail. Exact equality fails safe: a target that is
 * too wide matches nothing.
 *
 * One rule, two axes. The sender axis first: an exact address match, or an
 * exact domain match with the domain derived from the address through
 * {@link emailDomain}. Then the scope gate: a `null` target `accountId` is
 * cross-account and always eligible; a scoped target must name the caller's
 * mailbox. The default keeps existing two-arg callers compiling with today's
 * null-account semantics.
 */
export function targetMatchesSender(
  target: StandingInstructionTarget,
  senderEmail: string,
  accountId: string | null = null,
): boolean {
  let senderMatches: boolean;

  switch (target.kind) {
    case "sender_email":
      senderMatches = target.email === senderEmail;
      break;
    case "sender_domain": {
      const senderDomain = emailDomain(senderEmail);

      senderMatches = senderDomain !== null && target.domain === senderDomain;
      break;
    }

    default: {
      const exhaustive: never = target;
      void exhaustive;

      return false;
    }
  }

  if (!senderMatches) return false;

  if (target.accountId !== null && target.accountId !== accountId) return false;

  return true;
}

/**
 * Does `outer` cover every sender `inner` covers? Reflexive: a target covers
 * itself. This is the SUBSET/SUPERSET relation ADR-0060 micro-decision 6 names,
 * and it sits beside {@link targetMatchesSender} because it answers the same
 * question over a target instead of over one address — a `sender_domain` covers
 * exactly the addresses `targetMatchesSender` accepts for it.
 *
 * `sender_domain` covers a `sender_email` at that EXACT domain, and covers only
 * the identical domain. Never a subdomain, for the reason
 * {@link targetMatchesSender} states: a correct suffix rule needs a
 * public-suffix list, and without one `co.in` would cover a whole country.
 *
 * The SENDER axis only. `accountId` scopes an instruction to a mailbox, which
 * is the caller's question and not the target's — the same split
 * {@link targetMatchesSender} already makes.
 *
 * Two nested exhaustive guards, so a third target kind fails to compile until
 * it declares both what it covers and what covers it.
 */
export function standingInstructionTargetCovers(
  outer: StandingInstructionTarget,
  inner: StandingInstructionTarget,
): boolean {
  switch (outer.kind) {
    case "sender_email":
      switch (inner.kind) {
        case "sender_email":
          return outer.email === inner.email;
        // One address never covers a whole domain.
        case "sender_domain":
          return false;
        default: {
          const exhaustive: never = inner;
          void exhaustive;

          return false;
        }
      }

    case "sender_domain":
      switch (inner.kind) {
        case "sender_email":
          return targetMatchesSender(outer, inner.email);
        case "sender_domain":
          return outer.domain === inner.domain;
        default: {
          const exhaustive: never = inner;
          void exhaustive;

          return false;
        }
      }

    default: {
      const exhaustive: never = outer;
      void exhaustive;

      return false;
    }
  }
}

/**
 * How an EXISTING instruction relates to the one a write just stored, when the
 * two overlap but are not the same target. `wider` = the existing target covers
 * the stored one (a domain mute above an address pin); `narrower` = the stored
 * target covers the existing one.
 *
 * Only a STRICT relation is reported, so the identity row is never its own
 * overlap.
 */
export const STANDING_INSTRUCTION_OVERLAP_RELATIONS = ["wider", "narrower"] as const;

export type StandingInstructionOverlapRelation =
  (typeof STANDING_INSTRUCTION_OVERLAP_RELATIONS)[number];

/**
 * One active instruction that overlaps a write, reported on the successful
 * result so the model and the user learn what else already binds this sender.
 * ADR-0060 §6 asks `system.remember` to report a subset or superset overlap; at
 * v1 both rows always carry `suppress`, so the overlap contradicts nothing and
 * ADR-0060 §8 already elects one of them at apply time.
 *
 * A minted report: never persisted, never parsed from outside, so it is an
 * interface and not a schema — the same call {@link StandingInstructionValue}'s
 * consumers make for `StandingInstructionSummary`.
 */
export interface StandingInstructionOverlap {
  factId: string;
  /** The EXISTING instruction, seen from the one just written. */
  relation: StandingInstructionOverlapRelation;
  target: StandingInstructionTarget;
  directive: string;
}

/**
 * Why a write that asked for `scope:"domain"` stored a `sender_email` target
 * instead. Each member is read off a real branch of the corporate-domain rail:
 * `emailDomain(email)` answering `null`, and `classifyEmailDomain` answering
 * anything but `corporate_domain`.
 */
export const STANDING_INSTRUCTION_SCOPE_NARROWINGS = [
  "domain_not_single_organization",
  "domain_unparseable",
] as const;

export type StandingInstructionScopeNarrowing =
  (typeof STANDING_INSTRUCTION_SCOPE_NARROWINGS)[number];

/**
 * ADR-0060 §8, most specific first. Position IS the rank. The deferred kinds
 * slot in at their ADR position when they ship — `category` after
 * `sender_domain`, then `topic` — and the insertion renumbers every later kind,
 * which nothing observes because only relative order is compared.
 */
const STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER = [
  "sender_email",
  "sender_domain",
] as const satisfies readonly StandingInstructionTargetKind[];

/**
 * How specific a target is — a higher number wins. ADR-0060 micro-decision 8
 * fixes the apply-time precedence: when several instructions match one sender,
 * the most specific target wins and recency only breaks a tie. The order the
 * ADR names is `sender_email`/`person` > `sender_domain` > `category` >
 * `topic`.
 *
 * The rank is the position in
 * {@link STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER}, most specific first,
 * inverted so a higher number is more specific. A developer states a position,
 * never a number, so a kind cannot be placed at a rank the order does not name.
 * The order tuple is not exported, so no call site can index it.
 *
 * The rule was unreachable while `sender_email` was the only kind. It became
 * reachable with `sender_domain`, because the user can pin one address inside a
 * domain the same user already muted, and both rows then match the same sender.
 * Without this rank the newer row wins, so a domain mute written after the pin
 * defeats the pin.
 *
 * The coverage gate is `indexOf(target.kind)`: `indexOf` is declared on the
 * tuple's element union, and `target.kind` is the full
 * {@link StandingInstructionTargetKind} union, so a kind the union gains and
 * the tuple lacks fails to compile. A member the tuple gains and the union
 * lacks fails `satisfies`. Position within the tuple is an ordering decision
 * the compiler cannot check; the ADR reference above is what ties the tuple to
 * §8.
 *
 * This lives beside {@link standingInstructionTargetKey} and
 * {@link targetMatchesSender} so the rank sits with the union it ranks.
 */
export function standingInstructionTargetSpecificity(target: StandingInstructionTarget): number {
  return (
    STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER.length -
    STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER.indexOf(target.kind)
  );
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
