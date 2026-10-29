/**
 * Standing instructions: durable directives the user states in plain words
 * ("stop emailing me about Ben Book"). Stored as a `user_facts` row with
 * `key="standing_instruction"` (ADR-0056, 0057, 0058). Targets are a union on
 * `kind`: a sender address or a sender domain.
 */

import { z } from "zod";
import { documentAskProposalSchema } from "./document-ask";
import { domainSchema, emailDomain, normalizeEmailAddress } from "./domain";
import {
  triageCategorySchema,
  triageTodoDecisionSchema,
  triageTodoSuggestionSchema,
  type TriageCategory,
} from "./triage";

export const STANDING_INSTRUCTION_KEY = "standing_instruction";

/** Bump on an incompatible `value` change. Writers stamp the current version. */
export const STANDING_INSTRUCTION_SCHEMA_VERSION = 1 as const;

// ─── Action ──────────────────────────────────────────────────────────────

/** Only `suppress` at v1. */
export const STANDING_INSTRUCTION_ACTIONS = ["suppress"] as const;

export type StandingInstructionAction = (typeof STANDING_INSTRUCTION_ACTIONS)[number];

export const standingInstructionActionSchema = z.enum(STANDING_INSTRUCTION_ACTIONS);

// ─── Surface (display label, not the contract) ──────────────────────────────

/**
 * Shown in UI and used to phrase `directive`. Never branch on it.
 * `open_loop` suppresses the nag, todo, and briefing item, not the email.
 */
export const STANDING_INSTRUCTION_SURFACES = ["open_loop"] as const;

export type StandingInstructionSurface = (typeof STANDING_INSTRUCTION_SURFACES)[number];

export const standingInstructionSurfaceSchema = z.enum(STANDING_INSTRUCTION_SURFACES);

// ─── Effects ────────────────────────────────────────────────────────────────

/**
 * The v1 write snapshot: v1 writers store the full list. Readers never branch on it. They read
 * the v2 view (`readStoredStandingInstruction`), which lifts every v1 row to the effects that
 * ADR-0106 and ADR-0110 enforce. A new consumer adds a v2 effect, not one here.
 * - `block_todo_suggestion`: triage mints no todo suggestion.
 * - `exclude_briefing_priority`: briefing gather drops it from the priority buckets.
 * - `block_reply_draft`: the reply-drafting gate returns `no_draft` (ADR-0098).
 * - `deprioritize_triage_category`: a category prior for `classify`, not a floor,
 *   because "an urgent one may still surface" needs a model (ADR-0066, ADR-0051).
 *   The only effect that can change the user's Gmail label.
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
 * `sender_domain` covers every address at one host, including future senders.
 * Users often name a class ("all investment senders"), and an address list cannot grow.
 */
export const STANDING_INSTRUCTION_TARGET_KINDS = ["sender_email", "sender_domain"] as const;

export type StandingInstructionTargetKind = (typeof STANDING_INSTRUCTION_TARGET_KINDS)[number];

export const standingInstructionTargetKindSchema = z.enum(STANDING_INSTRUCTION_TARGET_KINDS);

/** Canonical through {@link normalizeEmailAddress}, which also accepts `<>` and `mailto:`. */
const senderEmailAddressSchema: z.ZodType<string, string> = z
  .string()
  .transform((value) => normalizeEmailAddress(value))
  .refine((value): value is string => value !== null, {
    message: "must be a valid email address",
  });

/**
 * The match key is canonical when stored, so readers never re-normalize.
 * `accountId: null` means every mailbox. The `sender_domain` arm has no label:
 * a person's name would mislabel a whole domain. Old rows with one still parse
 * (`z.object` strips it), so the version stays 1.
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
    accountId: z.string().nullable(),
  }),
]);

export type StandingInstructionTarget = z.infer<typeof standingInstructionTargetSchema>;

/**
 * The corporate-domain gate (`classifyBareDomain`) runs at the mint boundary,
 * so this takes the gated `domain` and only picks the arm.
 */
export interface BuildStandingInstructionTargetInput {
  email: string;
  domain: string | null;
  label: string | null;
  accountId: string | null;
}

/** Build the stored target. A new kind needs an input channel here. */
export function buildStandingInstructionTarget(
  input: BuildStandingInstructionTargetInput,
): StandingInstructionTarget {
  if (input.domain !== null) {
    return {
      kind: "sender_domain",
      domain: input.domain,
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
 * One mailbox, or a class of senders? Per-kind rules elsewhere ask this, not the
 * kind. The exhaustive `switch` makes a new kind (ADR-0060 schedules `category`
 * and `topic`) declare its answer here. Narrows, so `true` allows reading `label`.
 */
export function targetNamesOneMailbox(
  target: StandingInstructionTarget,
): target is Extract<StandingInstructionTarget, { kind: "sender_email" }> {
  switch (target.kind) {
    case "sender_email":
      return true;
    case "sender_domain":
      return false;
    default: {
      const exhaustive: never = target;

      return Boolean(exhaustive);
    }
  }
}

/**
 * The directive sentence from the target alone: "any sender at <domain>" or
 * "from <label ?? email>". Domain rows always use it, so a domain rule never names
 * one address. Address rows keep the model's prose; this is only their default.
 */
export function renderStandingInstructionDirective(target: StandingInstructionTarget): string {
  switch (target.kind) {
    case "sender_domain":
      return `Stop surfacing reminders and briefing items from any sender at ${target.domain}.`;
    case "sender_email":
      return `Stop surfacing reminders and briefing items from ${target.label ?? target.email}.`;
    default: {
      const exhaustive: never = target;

      return String(exhaustive);
    }
  }
}

/** `"sender_email:a@b.com"` or `"sender_domain:b.com"`. Equal keys name the same thing. */
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
 * Does this target cover this sender? Pure string comparison: triage calls it per message.
 * Takes the address only and derives the domain, so the two cannot disagree.
 * Exact domains only: a suffix rule without a public-suffix list would let `co.in`
 * suppress a country. A `null` target `accountId` matches every mailbox.
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
 * An active instruction that overlaps a write, reported back to the model and user
 * (ADR-0060 §6). Only a strict relation counts, so a row never overlaps itself.
 */
export interface StandingInstructionOverlap {
  factId: string;
  /** How the existing instruction relates to the one just written. `wider` contains it. */
  relation: "wider" | "narrower";
  target: StandingInstructionTarget;
  directive: string;
}

type StandingInstructionScopeAxis = "wider" | "narrower" | "same" | "disjoint";

/**
 * The sender axis: the {@link targetMatchesSender} rule without the account gate.
 * Exact domains only. Identity is {@link standingInstructionTargetKey} equality.
 */
function senderScopeAxis(
  of: StandingInstructionTarget,
  relativeTo: StandingInstructionTarget,
): StandingInstructionScopeAxis {
  if (
    of.kind === relativeTo.kind &&
    standingInstructionTargetKey(of) === standingInstructionTargetKey(relativeTo)
  ) {
    return "same";
  }

  switch (of.kind) {
    case "sender_email":
      switch (relativeTo.kind) {
        case "sender_email":
          return "disjoint";
        // One address never covers a domain. It can only sit under one.
        case "sender_domain": {
          const senderDomain = emailDomain(of.email);

          return senderDomain !== null && relativeTo.domain === senderDomain
            ? "narrower"
            : "disjoint";
        }

        default: {
          const exhaustive: never = relativeTo;
          void exhaustive;

          return "disjoint";
        }
      }

    case "sender_domain":
      switch (relativeTo.kind) {
        case "sender_email": {
          const senderDomain = emailDomain(relativeTo.email);

          return senderDomain !== null && of.domain === senderDomain ? "wider" : "disjoint";
        }

        case "sender_domain":
          return "disjoint";
        default: {
          const exhaustive: never = relativeTo;
          void exhaustive;

          return "disjoint";
        }
      }

    default: {
      const exhaustive: never = of;
      void exhaustive;

      return "disjoint";
    }
  }
}

/**
 * The account axis. `null` binds every mailbox, so it is wider than one.
 * The duplicate check re-spells `same` as `===`: change both together.
 */
function accountScopeAxis(
  of: StandingInstructionTarget,
  relativeTo: StandingInstructionTarget,
): StandingInstructionScopeAxis {
  if (of.accountId === relativeTo.accountId) return "same";

  if (of.accountId === null) return "wider";

  if (relativeTo.accountId === null) return "narrower";

  return "disjoint";
}

/**
 * How the scope `of` nests in `relativeTo`, across senders and mailboxes (ADR-0060).
 * `null` when neither contains the other, including a domain row in one mailbox
 * against an address row in every mailbox: they intersect but do not nest.
 */
export function standingInstructionScopeRelation(pair: {
  readonly of: StandingInstructionTarget;
  readonly relativeTo: StandingInstructionTarget;
}): StandingInstructionOverlap["relation"] | null {
  const sender = senderScopeAxis(pair.of, pair.relativeTo);
  const account = accountScopeAxis(pair.of, pair.relativeTo);

  if (sender === "disjoint" || account === "disjoint") return null;

  // Both `same` is the identity row, which the strict guard refuses.
  if (sender === "same") return account === "same" ? null : account;

  if (account === "same") return sender;

  // Opposite directions intersect without nesting.
  return sender === account ? sender : null;
}

/**
 * Why a `scope:"domain"` write stored a `sender_email` target instead.
 * - `domain_unparseable`: zod's email pattern is looser than `domainSchema`,
 *   so `a@ab-.com` gets here.
 * - `domain_not_single_organization`: `classifyBareDomain` did not say `corporate_domain`.
 */
export const STANDING_INSTRUCTION_SCOPE_NARROWINGS = [
  "domain_not_single_organization",
  "domain_unparseable",
] as const;

export type StandingInstructionScopeNarrowing =
  (typeof STANDING_INSTRUCTION_SCOPE_NARROWINGS)[number];

/** Inputs a domain target cannot store: it renders its own sentence and has no label. */
export type StandingInstructionDroppedInput = "directive" | "senderLabel";

/** ADR-0060 §8, most specific first. Only relative order matters. */
const STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER = [
  "sender_email",
  "sender_domain",
] as const satisfies readonly StandingInstructionTargetKind[];

/**
 * Higher wins when several instructions match one sender; recency breaks ties
 * (ADR-0060). Without it, a domain mute written after an address pin defeats the pin.
 * `indexOf(target.kind)` fails to compile if the order tuple misses a kind.
 */
export function standingInstructionTargetSpecificity(target: StandingInstructionTarget): number {
  return (
    STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER.length -
    STANDING_INSTRUCTION_TARGET_SPECIFICITY_ORDER.indexOf(target.kind)
  );
}

// ─── The `user_facts.value` shape ───────────────────────────────────────────

/**
 * Rejects newlines: a multi-line value could forge a `===` prompt section.
 * Rejected, not stripped, so the user's words are never rewritten.
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
  /** A write snapshot. Do not branch on it: see `SUPPRESSION_EFFECTS`. */
  effects: z.array(suppressionEffectSchema).min(1),
  /** Prompt-ready sentence. */
  directive: singleLineProse,
  /** The user's words, for provenance and UI. Never parsed. */
  phrasing: singleLineProse,
});

export type StandingInstructionValue = z.infer<typeof standingInstructionValueSchema>;

// ─── Schema v2 (ADR-0113) ───────────────────────────────────────────────────

/**
 * The v2 effect registry (ADR-0113). Capture stores only the effects the words ask for,
 * and readers branch on the stored list. An effect enters only with a consumer that enforces it.
 * - `demote_urgent`: `urgent` becomes `action_needed`.
 * - `demote_demand`: `urgent` and `action_needed` become `fyi` (the ADR-0110 floor).
 * - `demote_meeting`: `meeting` becomes `fyi`.
 * - `force_category`: the user's own category for the mail.
 * - `block_todo_suggestion`, `exclude_briefing_priority`, `include_briefing_priority`,
 *   `block_reply_draft`: the triage todo lane, briefing gather, and the reply-draft gate.
 * The security floor outranks every lowering effect.
 */
export const STANDING_INSTRUCTION_EFFECT_KINDS = [
  "demote_urgent",
  "demote_demand",
  "demote_meeting",
  "force_category",
  "block_todo_suggestion",
  "exclude_briefing_priority",
  "include_briefing_priority",
  "block_reply_draft",
] as const;

export type StandingInstructionEffectKind = (typeof STANDING_INSTRUCTION_EFFECT_KINDS)[number];

type ParameterlessEffectKind = Exclude<StandingInstructionEffectKind, "force_category">;

const PARAMETERLESS_EFFECT_KINDS = STANDING_INSTRUCTION_EFFECT_KINDS.filter(
  (kind): kind is ParameterlessEffectKind => kind !== "force_category",
);

export const standingInstructionEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(PARAMETERLESS_EFFECT_KINDS) }),
  z.object({ kind: z.literal("force_category"), category: triageCategorySchema }),
]);

export type StandingInstructionEffect = z.infer<typeof standingInstructionEffectSchema>;

/**
 * How much of a mail a matched instruction covers (ADR-0113 E2). `all`: every reason for
 * the demand in the model verdict is inside the scope. A missing or unknown value reads as `part`.
 */
export const STANDING_INSTRUCTION_COVERAGES = ["all", "part"] as const;

export type StandingInstructionCoverage = (typeof STANDING_INSTRUCTION_COVERAGES)[number];

export const standingInstructionCoverageSchema = z
  .enum(STANDING_INSTRUCTION_COVERAGES)
  .catch("part");

/** The demand order of E2: `urgent`, then `action_needed`, then every other category. */
const DEMAND_RANK = {
  urgent: 2,
  action_needed: 1,
  awaiting_reply: 0,
  follow_up: 0,
  meeting: 0,
  payment: 0,
  done: 0,
  newsletter: 0,
  marketing: 0,
  fyi: 0,
} satisfies Record<TriageCategory, number>;

function demandRank(category: TriageCategory): number {
  return DEMAND_RANK[category];
}

/** `urgent` or `action_needed`: the demand lanes that a lowering effect can leave. */
export function isDemandCategory(category: TriageCategory): boolean {
  return demandRank(category) > 0;
}

/**
 * Does this effect raise the item, or lower, hide, or block it (ADR-0113 E2)? A
 * `force_category` raises only when its category is above the model verdict. A move between
 * two categories outside the demand lanes counts as a lowering.
 */
export function standingInstructionEffectRaises(
  effect: StandingInstructionEffect,
  modelCategory: TriageCategory,
): boolean {
  switch (effect.kind) {
    case "include_briefing_priority":
      return true;
    case "force_category":
      return demandRank(effect.category) > demandRank(modelCategory);
    case "demote_urgent":
    case "demote_demand":
    case "demote_meeting":
    case "block_todo_suggestion":
    case "exclude_briefing_priority":
    case "block_reply_draft":
      return false;
    default: {
      const exhaustive: never = effect;

      return Boolean(exhaustive);
    }
  }
}

/**
 * Raise on any part, lower only on full cover (ADR-0113 E2). A target or a full cue match
 * passes `all`; a scope match passes the model's `covers`.
 */
export function standingInstructionEffectApplies(
  effect: StandingInstructionEffect,
  context: { coverage: StandingInstructionCoverage; modelCategory: TriageCategory },
): boolean {
  return (
    context.coverage === "all" || standingInstructionEffectRaises(effect, context.modelCategory)
  );
}

export const STANDING_INSTRUCTION_SCHEMA_VERSION_V2 = 2 as const;

/**
 * The v2 `user_facts.value` (ADR-0113). `instructionId` is stable across edits, because an
 * edit closes the fact row and inserts a successor; `revision` increases at each change.
 * Matches and `exceptionOf` key on the instruction id, never on the fact id.
 */
export const standingInstructionValueV2Schema = z
  .object({
    schemaVersion: z.literal(STANDING_INSTRUCTION_SCHEMA_VERSION_V2),
    instructionId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    /** The user's own words, verbatim. */
    phrasing: singleLineProse,
    /** The resolved sentence for model consumers. */
    directive: singleLineProse,
    /** Which items the instruction is about, for the triage model's match. */
    scope: singleLineProse.optional(),
    /** Senders the words name, for the whole sender. Matched in code. Optional: absent is none. */
    targets: z.array(standingInstructionTargetSchema).default([]),
    /** Senders that narrow `scope`. Never matches alone. */
    senderFilter: z.array(standingInstructionTargetSchema).optional(),
    effects: z.array(standingInstructionEffectSchema),
    /** The `instructionId` of a broader instruction that this one narrows. */
    exceptionOf: z.string().min(1).optional(),
    /** Hints and display only. Code never matches on it (ADR-0113 E5). */
    notes: z.json().optional(),
  })
  .refine((value) => value.senderFilter === undefined || value.scope !== undefined, {
    message: "senderFilter needs a scope",
    path: ["senderFilter"],
  });

export type StandingInstructionValueV2 = z.infer<typeof standingInstructionValueV2Schema>;

/** The effects ADR-0106 and ADR-0110 enforce for every v1 row. */
const V1_ENFORCED_EFFECTS: readonly StandingInstructionEffect[] = [
  { kind: "demote_demand" },
  { kind: "block_todo_suggestion" },
  { kind: "exclude_briefing_priority" },
  { kind: "block_reply_draft" },
];

/**
 * A v1 row as a v2 instruction: one sender target, no scope, and the effects it enforces
 * today. The fact id stands in for the instruction id, so an edit of a v1 row reads as a
 * new instruction. A class target renders its sentence from the target.
 */
export function liftStandingInstructionV1(
  value: StandingInstructionValue,
  factId: string,
): StandingInstructionValueV2 {
  return {
    schemaVersion: STANDING_INSTRUCTION_SCHEMA_VERSION_V2,
    instructionId: factId,
    revision: 0,
    phrasing: value.phrasing,
    directive: targetNamesOneMailbox(value.target)
      ? value.directive
      : renderStandingInstructionDirective(value.target),
    targets: [value.target],
    effects: [...V1_ENFORCED_EFFECTS],
  };
}

/** Any stored version, read as v2. `null` when the value is neither shape. */
export function readStoredStandingInstruction(
  value: unknown,
  factId: string,
): StandingInstructionValueV2 | null {
  const v2 = standingInstructionValueV2Schema.safeParse(value);

  if (v2.success) return v2.data;

  const v1 = standingInstructionValueSchema.safeParse(value);

  return v1.success ? liftStandingInstructionV1(v1.data, factId) : null;
}

/** Does the instruction store this effect? Readers branch on the v2 list. */
export function standingInstructionHasEffect(
  value: StandingInstructionValueV2,
  kind: StandingInstructionEffectKind,
): boolean {
  return value.effects.some((effect) => effect.kind === kind);
}

// ─── The stored triage evaluation (ADR-0113, "Lifetime of a stored match") ──────

/**
 * The `email_triage.model_verdict` column: the verdict after the system floors and before
 * any standing-instruction effect. `exposedSecret` lets a consumer apply the security floor
 * with no mail text. Nothing rewrites it.
 */
export const triageModelVerdictSchema = z.object({
  category: triageCategorySchema,
  documentAsk: documentAskProposalSchema.nullable(),
  todoSuggestion: triageTodoSuggestionSchema,
  todoDecision: triageTodoDecisionSchema.nullable(),
  exposedSecret: z.boolean(),
});

export type TriageModelVerdict = z.infer<typeof triageModelVerdictSchema>;

/**
 * The result of one scoped instruction for one document, at the instruction's `revision`.
 * An instruction with no stored result is `unknown`, never `not_matched`.
 */
export const standingInstructionScopeResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("matched"),
    instructionId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    /** The model's one line of reason. */
    reason: z.string(),
    covers: standingInstructionCoverageSchema,
  }),
  z.object({
    state: z.literal("not_matched"),
    instructionId: z.string().min(1),
    revision: z.number().int().nonnegative(),
  }),
]);

export type StandingInstructionScopeResult = z.infer<typeof standingInstructionScopeResultSchema>;

/**
 * The `email_triage.instruction_evaluation` column. The content revision is the row's
 * `document_id`. `setRevision` is the per-user instruction-set revision that the evaluation read.
 */
export const triageInstructionEvaluationSchema = z.object({
  setRevision: z.number().int().nonnegative(),
  scopes: z.array(standingInstructionScopeResultSchema),
});

export type TriageInstructionEvaluation = z.infer<typeof triageInstructionEvaluationSchema>;
