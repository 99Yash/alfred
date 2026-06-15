/**
 * Standing instructions — the durable, behavior-changing directives the user
 * states in plain language ("stop emailing me about Ben Book"). ADR-0056/0057
 * governance; ADR-0058 store (a `user_facts` row, `key="standing_instruction"`,
 * structured JSONB `value` — no new table). Zero Node deps — safe to import from
 * `apps/web`, `packages/db` (`.$type<T>()`), `packages/api`, `packages/sync`.
 *
 * The enums + the `value` schema live here so the `user_facts` column type, the
 * `system.remember` write tool, and the triage/briefing readers all agree by
 * construction. The load-bearing closed enum is `SUPPRESSION_EFFECTS`: each
 * consumer branches on a registered effect (never re-derives intent from the
 * product-label `surface`), the way `TOOL_LABELS` centralizes tool copy. A new
 * consumer registers its effect here first.
 *
 * v1 slice = sender-scoped suppression (the "Ben Book" loop, see
 * docs/plans/long-term-memory-v1.md). Topic-scope + non-suppress actions are
 * deferred variants of the same shape.
 */

import { z } from "zod";

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
 * The concrete, registered effects of a standing instruction. Each consumer
 * checks for its own effect — it never asks "does this `surface` include me?".
 * Register a new effect here before a new consumer reads it.
 *
 * `block_todo_suggestion`     — triage `classify` mints no `todoSuggestion` for a matching email.
 * `exclude_briefing_priority` — briefing `gather` drops the match from the priority buckets.
 */
export const SUPPRESSION_EFFECTS = ["block_todo_suggestion", "exclude_briefing_priority"] as const;
export type SuppressionEffect = (typeof SUPPRESSION_EFFECTS)[number];
export const suppressionEffectSchema = z.enum(SUPPRESSION_EFFECTS);

// ─── Target ────────────────────────────────────────────────────────────────

/** `sender_email` — bind to a sender address. Only target kind at v1. */
export const STANDING_INSTRUCTION_TARGET_KINDS = ["sender_email"] as const;
export type StandingInstructionTargetKind = (typeof STANDING_INSTRUCTION_TARGET_KINDS)[number];
export const standingInstructionTargetKindSchema = z.enum(STANDING_INSTRUCTION_TARGET_KINDS);

/**
 * Resolve-at-write: `email` is the canonical match key (resolved from the
 * user's words at capture time — never the display name). The schema itself
 * **normalizes** (trim → lowercase) and **validates** email shape, so a parsed
 * `target.email` is guaranteed canonical — readers can match on it directly
 * without re-normalizing. `accountId` is `null` = cross-account (suppress the
 * sender, not one mailbox); a future per-account scope sets it without a reshape.
 */
export const standingInstructionTargetSchema = z.object({
  kind: standingInstructionTargetKindSchema,
  email: z.string().trim().toLowerCase().pipe(z.email()),
  label: z.string().nullish(),
  accountId: z.string().nullable(),
});
export type StandingInstructionTarget = z.infer<typeof standingInstructionTargetSchema>;

// ─── The `user_facts.value` shape ───────────────────────────────────────────

export const standingInstructionValueSchema = z.object({
  schemaVersion: z.literal(STANDING_INSTRUCTION_SCHEMA_VERSION),
  action: standingInstructionActionSchema,
  surface: standingInstructionSurfaceSchema,
  target: standingInstructionTargetSchema,
  /** The operational contract. Consumers branch on membership here. */
  effects: z.array(suppressionEffectSchema).min(1),
  /** Resolved, prompt-ready sentence a prose consumer can drop in verbatim. */
  directive: z.string().min(1),
  /** Verbatim user words — provenance/UI only. No pipeline ever parses this. */
  phrasing: z.string().min(1),
});
export type StandingInstructionValue = z.infer<typeof standingInstructionValueSchema>;

/** True iff this instruction carries the given effect. */
export function hasSuppressionEffect(
  value: StandingInstructionValue,
  effect: SuppressionEffect,
): boolean {
  return value.effects.includes(effect);
}
