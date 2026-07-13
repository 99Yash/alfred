/**
 * Briefing context signals + the memory-write policy that keeps briefings
 * agent-safe (ADR-0083, #415, under the #218 user-model spine).
 *
 * A briefing is a *render of the open-loop model* (ADR-0048), not a summary of
 * inputs. Everything a writer model says about the user's day flows through
 * three layers, and this module owns the boundary between them:
 *
 *   1. **Source evidence** — raw, provenance-bearing items the gather already
 *      exposes (a Gmail thread, a calendar event, a GitHub activity row). Each
 *      is addressable by a `BriefingReference` token (`briefing-references.ts`);
 *      they are validated at their owning boundary, never authored by an LLM.
 *   2. **Typed context signals** — the closed vocabulary in this file. Each
 *      signal is *derived deterministically or by a bounded projection* from
 *      Layer 1, carries its evidence back to Layer 1, and is crisp,
 *      source-backed, and bounded. This is the layer a composer reasons over.
 *   3. **Generated briefing prose** — the warm paragraph the writer emits. It
 *      *consumes* Layer 2, invents no durable facts, and is intentionally NOT a
 *      type in this module: prose is ephemeral by construction and must never
 *      round-trip into `user_facts`.
 *
 * The point of the split is the standing architectural tenet (ADR-0067/0080):
 * a **deterministic core, prose only at the edge**. A writer model may phrase
 * evidence warmly ("shipped a lot this week"), but that warmth is Layer 3 — it
 * is derived at query time from Layer 2 signals, and is never persisted as a
 * free-form fact.
 *
 * ── Memory write policy (the guardrail this file names, other modules enforce)
 *
 * These signals are a namespace *disjoint* from `FACT_ONTOLOGY`: a briefing
 * signal is never a `user_facts.key`, and briefing prose never writes identity
 * or org facts. Concretely, briefing work must not:
 *   - promote email/document metadata (subject, sender, message-id, dates) or a
 *     third party's attributes (a recruiter's company, a contact's city) into
 *     the user's identity/org facts — the `yash.k@oliv.ai` /
 *     `employer="Weekday"` failure mode (see
 *     `.lessons/user-facts-document-metadata-noise.md`; ADR-0079 §Layer-2 gate
 *     and ADR-0080 aboutness-by-construction are where that is *enforced*);
 *   - persist a vague observation — shipping mood, motivation, warmth — as a
 *     durable fact. Those are `ephemeral_query_time` signals: derived at render
 *     time, at most backed by a *bounded* projection, and dropped after use.
 *
 * Durable identity/org writes remain the job of the ADR-0080 identity
 * projection (`PROJECTION_IDENTITY_KEYS`, `identity-affiliation.ts`) governed by
 * "no grounding, no row"; this module only classifies which briefing signals
 * are even *eligible* to back a bounded projection vs. which are strictly
 * render-time.
 *
 * Pure module — no Node imports (consumed across the web boundary), mirroring
 * `briefing.ts` / `user-model.ts`.
 */

import { z } from "zod";

import { parseBriefingReference, type BriefingReference } from "./briefing-references";

// ───────────────────────────────────────────────────────────────────────────
// Durability — the Layer-2 → memory-write gate
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whether a signal kind may back a durable (replayable, bounded) projection or
 * is strictly render-time.
 *
 * - `grounded_projection` — the signal reflects an object-state fact with
 *   positive evidence (a loop that closed, a discrete job-search event, a
 *   scope gap). It *may* be materialized as a bounded projection under the
 *   ADR-0067 observation-log rules. It is still never an identity/org fact.
 * - `ephemeral_query_time` — the signal is a soft, aggregate read of the day
 *   (momentum / mood / warmth). It is derived at render time and MUST NOT be
 *   persisted as a free-form fact (ADR-0080 "evidence-only never promotes").
 */
export const BRIEFING_SIGNAL_DURABILITIES = ["grounded_projection", "ephemeral_query_time"] as const;
export const briefingSignalDurabilitySchema = z.enum(BRIEFING_SIGNAL_DURABILITIES);
export type BriefingSignalDurability = (typeof BRIEFING_SIGNAL_DURABILITIES)[number];

export interface BriefingContextSignalDef {
  readonly durability: BriefingSignalDurability;
  readonly description: string;
}

// ───────────────────────────────────────────────────────────────────────────
// The taxonomy (Layer 2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * First-pass briefing context-signal taxonomy (ADR-0083 §1). Ordered tuple is
 * the source of truth for the enum; `BRIEFING_CONTEXT_SIGNALS` below attaches
 * metadata and is asserted (`satisfies Record<...>`) to cover exactly these
 * kinds, so the two can't drift. Deliberately small and additive: later
 * briefing slices grow it, they do not fork it.
 */
export const BRIEFING_CONTEXT_SIGNAL_KINDS = [
  "closed_work_loop",
  "open_work_loop",
  "shipping_momentum",
  "job_search_event",
  "recurring_machine_noise",
  "integration_access_gap",
] as const;
export const briefingContextSignalKindSchema = z.enum(BRIEFING_CONTEXT_SIGNAL_KINDS);
export type BriefingContextSignalKind = (typeof BRIEFING_CONTEXT_SIGNAL_KINDS)[number];

export const BRIEFING_CONTEXT_SIGNALS = {
  /**
   * A loop that reconciled *shut* on a positive authoritative signal (a PR
   * merged, a reply was sent). Closure requires positive evidence — silence
   * never closes a loop (ADR-0048 source-availability contract).
   */
  closed_work_loop: {
    durability: "grounded_projection",
    description:
      "An open loop closed on positive authoritative evidence (PR merged, reply sent). Silence never closes a loop.",
  },
  /**
   * A loop still awaiting the user or still shaping the day — the honest
   * `action_needed` / `awaiting_reply` state, surfaced (not buried) and, when
   * the provider can't be verified, surfaced as live.
   */
  open_work_loop: {
    durability: "grounded_projection",
    description:
      "A loop still needing the user or shaping the day; surfaced as live when its provider state can't be verified.",
  },
  /**
   * A soft, aggregate read of shipping velocity across the day/week ("a lot
   * landed"). Render-time only: it colors the prose, it is NEVER a durable
   * fact. This is the exact class ADR-0080 forbids promoting.
   */
  shipping_momentum: {
    durability: "ephemeral_query_time",
    description:
      "A soft aggregate read of shipping velocity used to color prose. Derived at query time; never persisted as a fact.",
  },
  /**
   * A discrete job-search event (an interview scheduled, an offer, a stage
   * change). Situational state (ADR-0080) — time-bounded and decaying. It may
   * back a bounded projection but NEVER promotes to an identity fact: a
   * `target_org` the user is interviewing with is not their `employer`.
   */
  job_search_event: {
    durability: "grounded_projection",
    description:
      "A discrete, grounded job-search event (interview, offer, stage change). Situational state; never promotes to an identity/org fact.",
  },
  /**
   * Repetitive machine / distribution-list mail (tracker notifications,
   * alerts, digests) that recurs. Feeds presentation-layer attention decay
   * (ADR-0064) and the entity-kind `service`/`group` gate (ADR-0067); it is
   * never treated as a person or an identity fact.
   */
  recurring_machine_noise: {
    durability: "grounded_projection",
    description:
      "Recurring machine/distribution-list mail (tracker notifications, alerts, digests) that feeds attention decay; never a person or a fact.",
  },
  /**
   * A capability gap that means a loop's current state couldn't be verified —
   * a missing OAuth scope, a disconnected integration, an API error, or a
   * `null` provider contribution. Per the source-availability contract this
   * keeps the loop live ("couldn't verify current state"), never inferring
   * closure.
   */
  integration_access_gap: {
    durability: "grounded_projection",
    description:
      "A missing scope / disconnected integration / provider error that prevents verifying a loop's state; keeps the loop live, never infers closure.",
  },
} as const satisfies Record<BriefingContextSignalKind, BriefingContextSignalDef>;

export function isBriefingContextSignalKind(value: string): value is BriefingContextSignalKind {
  return Object.prototype.hasOwnProperty.call(BRIEFING_CONTEXT_SIGNALS, value);
}

/** The declared durability for a signal kind. */
export function briefingSignalDurability(kind: BriefingContextSignalKind): BriefingSignalDurability {
  return BRIEFING_CONTEXT_SIGNALS[kind].durability;
}

/**
 * True iff this signal is strictly render-time and MUST NOT be persisted as a
 * free-form fact. The one machine-checkable expression of the "vague
 * observations are derived at query time, never stored" policy (ADR-0083 §3).
 */
export function isEphemeralBriefingSignal(kind: BriefingContextSignalKind): boolean {
  return briefingSignalDurability(kind) === "ephemeral_query_time";
}

// ───────────────────────────────────────────────────────────────────────────
// Bounds
// ───────────────────────────────────────────────────────────────────────────

/**
 * "Crisp, source-backed, bounded" is enforced, not just asserted. A signal's
 * optional phrasing hint is a short rendering aid, never a place to smuggle a
 * paragraph of durable narrative.
 */
export const MAX_BRIEFING_SIGNAL_DETAIL_LENGTH = 280;

/** A signal may not cite an unbounded fan of evidence — it is one loop's worth. */
export const MAX_BRIEFING_SIGNAL_EVIDENCE = 16;

// ───────────────────────────────────────────────────────────────────────────
// Shapes
// ───────────────────────────────────────────────────────────────────────────

/**
 * A Layer-1 provenance handle: a `BriefingReference` token (`email:<id>`,
 * `meeting:<id>`, `activity:<id>`) that resolves against a briefing's synced
 * `gather`. Signals cite these; the resolver in `briefing-references.ts`
 * expands them for rendering.
 */
export const briefingEvidenceRefSchema = z
  .string()
  .refine((value): value is BriefingReference => parseBriefingReference(value) !== null, {
    message: "Not a valid briefing reference token (expected `<kind>:<id>`).",
  });

/**
 * A typed briefing context signal (Layer 2). Evidence is **non-empty by
 * contract** — a signal without a Layer-1 handle is not a signal, mirroring
 * ADR-0080 "no grounding, no row." `durability` is derived from `kind` (see
 * {@link briefingSignalDurability}), never carried on the wire, so it can't be
 * spoofed to make an ephemeral signal look persistable.
 */
export const briefingContextSignalSchema = z
  .object({
    kind: briefingContextSignalKindSchema,
    evidence: z.array(briefingEvidenceRefSchema).min(1).max(MAX_BRIEFING_SIGNAL_EVIDENCE),
    /** Optional [0,1] confidence for signals derived by a bounded projection. */
    confidence: z.number().min(0).max(1).optional(),
    /**
     * Optional short phrasing hint for the writer. A rendering aid only — it is
     * NOT durable and must never be persisted as a fact (Layer 3 discipline).
     */
    detail: z.string().min(1).max(MAX_BRIEFING_SIGNAL_DETAIL_LENGTH).optional(),
  })
  .strict();
export type BriefingContextSignal = z.infer<typeof briefingContextSignalSchema>;
