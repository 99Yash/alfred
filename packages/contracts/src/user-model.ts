/**
 * Multi-source user-model substrate — typed registries (ADR-0067, #218).
 *
 * The tunable, no-migration knobs + closed enums for the event-sourced
 * observation log and its projections. Same ergonomics as
 * `INTEGRATION_OBJECT_DEFS` (ADR-0062): text columns in Postgres, validated
 * against these registries at the app boundary, so the DB stays migration-light
 * while the legal value sets live in one typed place.
 *
 * Pure module — no Node imports (consumed across the web boundary). The one
 * thing that is NOT here is the stable-entity-id *computation*: it is an
 * HMAC keyed by a server secret, so the algorithm lives in `@alfred/db`
 * (`computeStableEntityId`) while this module owns only its input contract
 * (`StableEntityIdInput`, `STABLE_ENTITY_ID_VERSION`).
 *
 * Naming note: the legacy aggregate graph (`entities`, `entity_relations`,
 * `ENTITY_KINDS` in the memory module) coexists with this substrate through the
 * shadow phase (ADR-0067 D10) and is dropped only at cutover. The new layer
 * therefore uses distinct names — `ENTITY_NODE_KINDS`, `ENTITY_EDGE_TYPES`,
 * tables `entity_nodes` / `entity_edges` — to avoid colliding with it.
 */

import { z } from "zod";

// ───────────────────────────────────────────────────────────────────────────
// Observation sources + precedence (D1, D14)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Where an observation came from. Integrations feed the graph passively;
 * `user` / `alfred_chat` are first-class high-precedence sources (D14) — a
 * chat-captured standing instruction or a `/settings` correction is an
 * observation, not a side-channel write.
 */
export const OBSERVATION_SOURCES = [
  "gmail",
  "google_calendar",
  "github",
  "clickup",
  "notion",
  "railway",
  "vercel",
  "enrichment",
  "alfred_chat",
  "user",
] as const;
export const observationSourceSchema = z.enum(OBSERVATION_SOURCES);
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

/**
 * Conflict precedence for the fold (D14): rank first, then recency within a
 * rank. `user` beats `alfred_chat` beats first-party integrations beats
 * enrichment — regardless of time. Lower number wins. A projection may
 * *propose* facts from integrations, but must never overwrite a
 * user-authoritative correction.
 */
export const OBSERVATION_SOURCE_RANK: Readonly<Record<ObservationSource, number>> = {
  user: 0,
  alfred_chat: 1,
  // First-party integrations share rank 2 — recency breaks ties between them.
  gmail: 2,
  google_calendar: 2,
  github: 2,
  clickup: 2,
  notion: 2,
  railway: 2,
  vercel: 2,
  enrichment: 3,
} as const;

/**
 * Relationship-evidence kinds (D4/D15). A provider event can produce several
 * observations, but only relationship-bearing occurrences affect
 * significance/co-occurrence — a calendar reminder edit is not another meeting.
 * Extensible: a new reducer registers its evidence kinds here first.
 */
export const OBSERVATION_KINDS = [
  // gmail
  "email_message",
  // google_calendar
  "calendar_meeting",
  // github
  "github_pull_request",
  "github_review",
  "github_push",
  // user / alfred_chat (D14)
  "user_standing_instruction",
  "user_correction",
  "user_confirmation",
  "user_rejection",
  "user_profile_edit",
  "enrichment_fact",
] as const;
export const observationKindSchema = z.enum(OBSERVATION_KINDS);
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Closed `source → kind` map (D1/D15). `source` and `kind` are NOT independent
 * vocabularies: a kind is legal only for the source whose reducer emits it, so
 * `{ source: "gmail", kind: "github_push" }` is rejected. Sources whose reducers
 * don't exist yet (`clickup`/`notion`/`railway`/`vercel`) map to `[]` — no
 * observation kind is legal for them until their reducer registers one here.
 * `user` and `alfred_chat` share the full user-authored set (D14): the same
 * correction/confirmation can arrive from a `/settings` edit or from chat.
 */
export const OBSERVATION_KINDS_BY_SOURCE = {
  gmail: ["email_message"],
  google_calendar: ["calendar_meeting"],
  github: ["github_pull_request", "github_review", "github_push"],
  clickup: [],
  notion: [],
  railway: [],
  vercel: [],
  enrichment: ["enrichment_fact"],
  alfred_chat: [
    "user_standing_instruction",
    "user_correction",
    "user_confirmation",
    "user_rejection",
    "user_profile_edit",
  ],
  user: [
    "user_standing_instruction",
    "user_correction",
    "user_confirmation",
    "user_rejection",
    "user_profile_edit",
  ],
} as const satisfies Record<ObservationSource, readonly ObservationKind[]>;

/** True iff `kind` is one of the kinds the reducer for `source` may emit. */
export function isObservationKindForSource(
  source: ObservationSource,
  kind: ObservationKind,
): boolean {
  return (OBSERVATION_KINDS_BY_SOURCE[source] as readonly ObservationKind[]).includes(kind);
}

/**
 * The `(source, kind)` pair every reducer must satisfy before an observation is
 * written — closes the half-open vocabulary that independent `source`/`kind`
 * validation leaves (a `gmail` row carrying a `github_*` kind). P1's full
 * observation-insert schema composes this.
 */
export const observationSourceKindSchema = z
  .object({
    source: observationSourceSchema,
    kind: observationKindSchema,
  })
  .refine(({ source, kind }) => isObservationKindForSource(source, kind), {
    error: "observation kind is not valid for its source",
    path: ["kind"],
  });
export type ObservationSourceKind = z.infer<typeof observationSourceKindSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Identities + the stable-entity-id anchor rank (D2, D3)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Typed identity keys. Replaces the legacy untyped `aliases` jsonb blob;
 * `entity_identities` is unique on `(user_id, kind, value)` and is both the
 * dedup index and the join target observations resolve through.
 */
export const IDENTITY_KINDS = [
  "email",
  "github_login",
  "github_user_id",
  "slack_id",
  "notion_user_id",
  "google_directory_id",
  "domain",
  "phone",
] as const;
export const identityKindSchema = z.enum(IDENTITY_KINDS);
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export const identityRefSchema = z
  .object({
    kind: identityKindSchema,
    value: z.string().min(1),
  })
  .strict();
export type IdentityRef = z.infer<typeof identityRefSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const OBSERVATION_PARTICIPANT_ROLES = [
  "from",
  "to",
  "cc",
  "bcc",
  "organizer",
  "attendee",
  "author",
  "reviewer",
  "assignee",
  "committer",
] as const;
export const observationParticipantRoleSchema = z.enum(OBSERVATION_PARTICIPANT_ROLES);
export type ObservationParticipantRole = (typeof OBSERVATION_PARTICIPANT_ROLES)[number];

export const observationParticipantSchema = z
  .object({
    identity: identityRefSchema,
    role: observationParticipantRoleSchema,
    displayName: z.string().optional(),
    raw: z.string().optional(),
  })
  .strict();
export type ObservationParticipant = z.infer<typeof observationParticipantSchema>;

export const observationParticipantsSchema = z
  .object({
    items: z.array(observationParticipantSchema),
    recipientCount: z.number().int().nonnegative(),
    listId: z.string().nullable().optional(),
  })
  .strict();
export type ObservationParticipants = z.infer<typeof observationParticipantsSchema>;

export const observationPayloadSchema = jsonObjectSchema;
export type ObservationPayload = z.infer<typeof observationPayloadSchema>;

export const projectionProvenanceSchema = z
  .object({
    observationIds: z.array(z.string()).optional(),
    familyKeys: z.array(z.string()).optional(),
  })
  .catchall(jsonValueSchema);
export type ProjectionProvenance = z.infer<typeof projectionProvenanceSchema>;

/** Provider immutable account ids — stable handles that never change for an account. */
export const IMMUTABLE_ACCOUNT_ID_KINDS = [
  "github_user_id",
  "slack_id",
  "notion_user_id",
] as const satisfies readonly IdentityKind[];

/**
 * Anchor rank (D2/D3) — the *stable entity id* is content-addressed from the
 * best-ranked identity in an entity's hard-bridge component, and on merge the
 * node seeded by the best anchor survives (losers forward via
 * `supersedes_entity_id`). Lower wins. Not arrival order, not newest/oldest row.
 *
 * `verified` does not gate the *email* tier — an email observed in a From header
 * is still the canonical hard bridge (D3), so `email` anchors at tier 3 whether
 * or not a stronger verification exists. It DOES gate the *directory* tier: the
 * tier-2 slot means a *verified* Workspace Directory identity (D2/D3), so an
 * unverified `google_directory_id` falls back to the provider-account tier
 * rather than outranking email.
 *
 * Tie-break order after rank (resolved in the fold, not here): earliest
 * `first_seen_at` → normalized value lexicographic → entity id lexicographic.
 */
export const IDENTITY_ANCHOR_TIER = {
  /** User-pinned merge target / explicit user correction. */
  userPinned: 1,
  /** Verified first-party directory identity (Google Workspace). */
  directoryVerified: 2,
  /** Email identity (the canonical cross-source hard bridge). */
  email: 3,
  /** Provider immutable account ids + org domain. */
  providerAccountId: 4,
  /** Provider mutable handle (e.g. GitHub login — can be renamed). */
  providerHandle: 5,
  /** Provisional / source-local / unknown. */
  provisional: 6,
} as const;
export type IdentityAnchorTier = (typeof IDENTITY_ANCHOR_TIER)[keyof typeof IDENTITY_ANCHOR_TIER];

export interface IdentityAnchorInput {
  readonly kind: IdentityKind;
  /** True when this identity was set by an explicit user pin / correction (source `user`). */
  readonly userPinned?: boolean;
  /** Mirrors `entity_identities.verified` — gates the tier-2 directory slot (D2/D3). */
  readonly verified?: boolean;
}

/** Anchor rank for seed/merge-survivor selection (lower = stronger). See `IDENTITY_ANCHOR_TIER`. */
export function identityAnchorRank({
  kind,
  userPinned,
  verified,
}: IdentityAnchorInput): IdentityAnchorTier {
  if (userPinned) return IDENTITY_ANCHOR_TIER.userPinned;
  switch (kind) {
    case "google_directory_id":
      // Tier 2 means a *verified* Workspace Directory identity (D2/D3). An
      // unverified directory row must not outrank email — demote it to the
      // provider-account tier (it is still a Google-immutable id).
      return verified
        ? IDENTITY_ANCHOR_TIER.directoryVerified
        : IDENTITY_ANCHOR_TIER.providerAccountId;
    case "email":
      return IDENTITY_ANCHOR_TIER.email;
    case "github_user_id":
    case "slack_id":
    case "notion_user_id":
    case "domain":
      return IDENTITY_ANCHOR_TIER.providerAccountId;
    case "github_login":
      return IDENTITY_ANCHOR_TIER.providerHandle;
    case "phone":
      return IDENTITY_ANCHOR_TIER.provisional;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Stable-entity-id input contract (D2). The id is
 * `ent_<base32(hmacSha256(secret, canonicalJson(input)))>` — HMAC-keyed (not
 * raw SHA: emails/logins are guessable and these ids appear in client sync /
 * logs), content-addressed from a single normalized hard identity. The
 * computation lives in `@alfred/db` (`computeStableEntityId`) because it needs
 * a Node crypto + a server secret; this is the shape both sides agree on.
 *
 * Never seed from display name, kind, significance, canonical name, a random
 * id, or a projection version — only stable identity material + `userId`.
 */
export const STABLE_ENTITY_ID_VERSION = 1 as const;
export interface StableEntityIdInput {
  readonly v: typeof STABLE_ENTITY_ID_VERSION;
  readonly userId: string;
  readonly identityKind: IdentityKind;
  /** The normalized identity value (lowercased email, canonical login, etc.). */
  readonly normalizedValue: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Entity kinds + edge types (D5, D7)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The kind taxonomy (D7), classified into the *versioned* `entity_profiles`
 * (a better classifier can change `kind` without re-minting the stable id).
 * Non-humans are retained as typed nodes — queryable, recomputable, no signal
 * lost — but `group` / `service` / `repository` / `project` are NEVER
 * person-significance-scored (this is the dist-list HARD gate that fixes the
 * live `'Anthropic' via Engineering`-as-#1-person bug).
 */
export const ENTITY_NODE_KINDS = [
  "person",
  "organization",
  "group",
  "service",
  "repository",
  "project",
] as const;
export const entityNodeKindSchema = z.enum(ENTITY_NODE_KINDS);
export type EntityNodeKind = (typeof ENTITY_NODE_KINDS)[number];

/** Kinds that are never scored as a person (the dist-list / service gate, D7). */
export const NON_PERSON_ENTITY_KINDS = [
  "organization",
  "group",
  "service",
  "repository",
  "project",
] as const satisfies readonly EntityNodeKind[];

export function isPersonScorable(kind: EntityNodeKind): boolean {
  return kind === "person";
}

/**
 * Typed, traversable edges in the versioned relation projection. `co_occurrence`
 * is a separate weighted pair projection (D5) — an edge becomes a traversable
 * `frequent_collaborator` only after the promotion threshold; below that the
 * pair is queryable data, never walked.
 */
export const ENTITY_EDGE_TYPES = [
  "works_at",
  "member_of",
  "reports_to",
  "frequent_collaborator",
  "in_org",
] as const;
export const entityEdgeTypeSchema = z.enum(ENTITY_EDGE_TYPES);
export type EntityEdgeType = (typeof ENTITY_EDGE_TYPES)[number];

// ───────────────────────────────────────────────────────────────────────────
// Significance fold knobs (D5, D6) — locked values 2026-06-23
// ───────────────────────────────────────────────────────────────────────────

/**
 * Events above this participant count contribute ZERO pairwise co-occurrence —
 * a 50-person blast is not social evidence (D5). Below it, each pair gets
 * `weight += sourceWeight / participantCount`.
 */
export const FAN_OUT_CUTOFF = 12;

/**
 * A co-occurring pair becomes a traversable `frequent_collaborator` edge only
 * past this accumulated weight (D5). Below it the pair stays queryable but is
 * never traversed (keeps traversal small + indexed).
 */
export const PROMOTION_THRESHOLD = 2.0;

/**
 * Promotion guardrails so one noisy thread / PR can't mint a collaborator edge:
 * a pair must clear the weight bar AND be backed by at least this many distinct
 * observations across at least this many distinct event families.
 * `MIN_FAMILIES` is the load-bearing one — without it, a single long email
 * thread or one chatty PR accidentally promotes.
 */
export const PROMOTION_MIN_OBSERVATIONS = 3;
export const PROMOTION_MIN_FAMILIES = 2;

/**
 * Per-interaction significance weights (D6). Keys are fold-derived interaction
 * classes, not the raw `OBSERVATION_KINDS` vocabulary. The fold contributes
 * `pairWeight += SOURCE_WEIGHTS[key] / participantCount` (participantCount =
 * all resolved human-ish participants). With `PROMOTION_THRESHOLD = 2.0`, a 1:1
 * reply needs ~5 touches to promote, a direct thread ~7, and cc/list exposure
 * basically never promotes unless repeatedly real.
 *
 * Provenance note: P1 can only calibrate the Gmail weights against prod —
 * `github_*` and `calendar_meeting` stay provisional until P2/P3 shadow
 * validation. `github_push` is a strong object/repo signal but a weak
 * person↔person one, so it is intentionally low. `gmail_blast` is 0 (the
 * fan-out cutoff already zeroes its co-occurrence; kept explicit for non-person
 * significance accounting).
 */
export const SOURCE_WEIGHTS = {
  github_review: 1.0,
  calendar_meeting: 0.9,
  gmail_reply: 0.8,
  gmail_direct: 0.65,
  gmail_cc: 0.25,
  github_push: 0.25,
  gmail_blast: 0.0,
} as const;
export type SourceWeightKey = keyof typeof SOURCE_WEIGHTS;

export function sourceWeight(key: SourceWeightKey): number {
  return SOURCE_WEIGHTS[key];
}

export const significanceComponentsSchema = z
  .object({
    volume: z.number().nonnegative().optional(),
    reciprocity: z.number().min(0).max(1).optional(),
    sameOrg: z.number().min(0).max(1).optional(),
    interactionWeight: z.number().nonnegative().optional(),
    coOccurrenceWeight: z.number().nonnegative().optional(),
    topObservationIds: z.array(z.string()).optional(),
    lastSeenAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export type SignificanceComponents = z.infer<typeof significanceComponentsSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Projection run bookkeeping
// ───────────────────────────────────────────────────────────────────────────

export const PROJECTION_RUN_STATUS = ["running", "completed", "failed"] as const;
export const projectionRunStatusSchema = z.enum(PROJECTION_RUN_STATUS);
export type ProjectionRunStatus = (typeof PROJECTION_RUN_STATUS)[number];

export const projectionCursorValueSchema = z
  .object({
    lastObservationId: z.string().optional(),
    occurredAt: z.string().datetime().optional(),
    sourceCursor: jsonValueSchema.optional(),
  })
  .strict();
export type ProjectionCursorValue = z.infer<typeof projectionCursorValueSchema>;

/**
 * Per-source replay high-watermark, keyed by `ObservationSource` (NOT free
 * strings) so a typo key (`gihub`) can't silently strand a source's cursor.
 * Partial by design — a run consumes only the sources it touched, so missing
 * keys are legal; the default column value is `{}`.
 */
export const projectionSourceHighWatermarkSchema = z.partialRecord(
  observationSourceSchema,
  projectionCursorValueSchema,
);
export type ProjectionSourceHighWatermark = z.infer<typeof projectionSourceHighWatermarkSchema>;

export const projectionRowCountsSchema = z.record(z.string(), z.number().int().nonnegative());
export type ProjectionRowCounts = z.infer<typeof projectionRowCountsSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Fact ontology (D8)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Which subject a fact can bind to. Facts about people hang off their stable
 * entity node (the "personalized relevance" destination); facts about the user
 * bind to `{kind:'user'}`. `any` = either.
 */
export const FACT_SUBJECT_KINDS = ["user", "entity"] as const;
export const factSubjectKindSchema = z.enum(FACT_SUBJECT_KINDS);
export type FactSubjectKind = (typeof FACT_SUBJECT_KINDS)[number];

export interface FactTypeDef {
  readonly subject: FactSubjectKind | "any";
  readonly description: string;
}

/**
 * Registered durable fact-types (D8). A `user_facts.key` must validate against
 * this at the app boundary. Transient document content (passcodes, alarm names,
 * incident timestamps) is NOT a fact-type — it stays in the document /
 * `memory_chunk`, never auto-confirmed as a fact (this is the fix for the 397
 * junk-drawer rows). `standing_instruction` is reserved and governed by
 * `standing-instructions.ts`, not folded as an ontology value here.
 */
export const FACT_ONTOLOGY = {
  employer: { subject: "any", description: "Organization the subject works for." },
  job_title: { subject: "any", description: "Role / title." },
  team: { subject: "any", description: "Team or org unit." },
  manager: { subject: "any", description: "Who the subject reports to (entity ref)." },
  reports_to: { subject: "any", description: "Alias of manager for org-graph edges." },
  owns: {
    subject: "any",
    description: "Ownership / responsibility domains (projects, repos, areas).",
  },
  github_username: { subject: "any", description: "GitHub login." },
  timezone: { subject: "user", description: "IANA timezone." },
  location: { subject: "any", description: "City / region." },
} as const satisfies Record<string, FactTypeDef>;
export type FactKey = keyof typeof FACT_ONTOLOGY;

export function isFactKey(key: string): key is FactKey {
  return Object.prototype.hasOwnProperty.call(FACT_ONTOLOGY, key);
}
