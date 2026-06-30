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
import { classifyEmailDomain, domainClassSchema } from "./identity-affiliation.js";
import { STANDING_INSTRUCTION_KEY } from "./standing-instructions.js";

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
  "google_account",
  "google_calendar",
  "google_directory",
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
  // `google_directory` is first-party (and its verified identities anchor at the
  // strongest non-user IDENTITY tier, D2/D3), but identity-anchor strength and
  // fold-conflict precedence are different axes: a Directory-sourced FACT must
  // not silently beat a `user` correction, so it sits at the first-party rank.
  gmail: 2,
  google_account: 2,
  google_calendar: 2,
  google_directory: 2,
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
  // identity affiliation — a connected account asserting the user's org domain
  // (ADR-0080 §4a). Subject is always `{ kind: "user" }`; the SOURCE is the
  // integration that owns the account (NOT `user`), so an explicit user
  // correction outranks it. Emitted by integration connect/sweep, not a reducer
  // over inbound content.
  "user_org_affiliation",
  "enrichment_fact",
] as const;
export const observationKindSchema = z.enum(OBSERVATION_KINDS);
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Closed `source → kind` map (D1/D15). `source` and `kind` are NOT independent
 * vocabularies: a kind is legal only for the source whose reducer emits it, so
 * `{ source: "gmail", kind: "github_push" }` is rejected. Sources whose reducers
 * don't exist yet (`google_directory`/`clickup`/`notion`/`railway`/`vercel`) map
 * to `[]` — no observation kind is legal for them until their reducer registers
 * one here. (`google_directory` is registered as a source in P0 — its identity
 * kind `google_directory_id` and verified-directory anchor tier already exist —
 * so a Directory-originated identity/observation has a real `source` to attribute
 * to instead of masquerading as `google_calendar`; its profile/org-membership
 * kinds land with the P3 People-API reducer.)
 * `user` and `alfred_chat` share the full user-authored set (D14): the same
 * correction/confirmation can arrive from a `/settings` edit or from chat.
 */
export const OBSERVATION_KINDS_BY_SOURCE = {
  gmail: ["email_message"],
  // `user_org_affiliation`: the connected Google account asserts the user's org
  // domain (ADR-0080 §4a). This is account-level provenance, not a Gmail message
  // reducer event; keeping it on `google_account` prevents the future connect-time
  // emitter from pretending a generic Google credential came from Gmail.
  google_account: ["user_org_affiliation"],
  google_calendar: ["calendar_meeting"],
  google_directory: [],
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
 *
 * HARD P1 GATE: this pair-check is necessary but not sufficient. No raw
 * `.insert(observations)` (or projection write) is permitted until P1 lands an
 * `insertObservation`-style boundary parser that validates the source→kind combo,
 * the `participants` envelope, the `subject_identity` / `object_identity`
 * `IdentityRef`s, and the projection lifecycle fields. The DB columns are
 * deliberately bare `text`/`jsonb` (app-boundary validation, not pg enums — same
 * rationale as the rest of the schema), so that parser is the only thing standing
 * between a reducer bug and a permanently-corrupt log. Every P1+ writer routes
 * through it, the way `entity_nodes` writers route through `makeEntityNodeInsert`.
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
 *
 * People/org identifiers are the cross-source hard bridges (`email`,
 * `github_user_id`, …). NON-person nodes need an anchor too: every
 * `entity_nodes` row carries a NOT NULL `canonical_identity` (D2) and the kind
 * taxonomy (D7) admits `repository` / `project`, so those nodes need a hard
 * identity that is NOT a person/org key — otherwise P2 would have to abuse
 * `github_login` / `domain` to mint a repo id and collide semantically with
 * people. Hence:
 *   - `github_repository_id`        — GitHub's immutable numeric repo id (never renamed).
 *   - `github_repository_full_name` — `owner/repo` (mutable: rename/transfer), so it
 *                                     anchors only at the provider-handle tier.
 *   - `integration_object_key`      — generic provider object key for `project`
 *                                     nodes from other sources (ClickUp/Notion/
 *                                     Railway/Vercel), the ADR-0062 object-key shape.
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
  "github_repository_id",
  "github_repository_full_name",
  "integration_object_key",
] as const;
export const identityKindSchema = z.enum(IDENTITY_KINDS);
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export const MAX_IDENTITY_VALUE_BYTES = 1024;

const UTF8_ENCODER = new TextEncoder();

/**
 * Identity value contract. `computeStableEntityId` (the mint chokepoint, in
 * `@alfred/db`) and `entity_identities.value` (the live dedup key) both reject
 * an empty, surrounding-whitespace, or oversized value because a stable `ent_*`
 * id is permanent and must not be whitespace-sensitive — and normalizing it
 * silently is the caller's job, not the mint's. The contract boundary must
 * agree, or a reducer can write a contract-valid observation (`value:
 * " a@b.com "`, or a 2KB opaque provider id) that then fails projection. So
 * reject the same shapes HERE, fail-loud, rather than letting the asymmetry
 * strand a write.
 */
export const identityValueSchema = z
  .string()
  .min(1)
  .refine((v) => v === v.trim(), {
    error: "identity value must not have leading or trailing whitespace",
  })
  .refine((v) => UTF8_ENCODER.encode(v).byteLength <= MAX_IDENTITY_VALUE_BYTES, {
    error: `identity value must be <= ${MAX_IDENTITY_VALUE_BYTES} UTF-8 bytes`,
  });

/**
 * Identity kinds whose value is CASE-INSENSITIVE and so must be lowercased
 * before it becomes the dedup key / `ent_*` content-address input. Email and DNS
 * are case-insensitive by spec; GitHub logins and `owner/repo` names are
 * case-insensitive at the provider. Without folding, `Person@Example.com` and
 * `person@example.com` mint two different stable ids for one person — exactly the
 * split-brain D2 exists to prevent. The OTHER kinds are deliberately left as-is:
 * provider opaque ids (`slack_id` `U07ABC…`, `notion_user_id`,
 * `google_directory_id`) are case-SIGNIFICANT, numeric ids
 * (`github_user_id`/`github_repository_id`) are digits, and `phone` /
 * `integration_object_key` carry no safe blanket case rule — folding them would
 * corrupt a real distinct value.
 */
const CASE_FOLDED_IDENTITY_KINDS: ReadonlySet<IdentityKind> = new Set([
  "email",
  "domain",
  "github_login",
  "github_repository_full_name",
]);

/**
 * The ONE canonicalizer for an identity value (D2). Stable `ent_*` ids are
 * content-addressed from this output, so every reducer (P1 Gmail, P2 GitHub, …)
 * and the mint chokepoint MUST run the SAME normalization or they mint diverging
 * anchors for one identity. Centralizing it here — rather than letting each
 * reducer lowercase "however it remembers to" — is what keeps the address space
 * single-valued. Trims, then lowercases the case-insensitive kinds. Idempotent:
 * `canonicalize(canonicalize(x)) === canonicalize(x)`, which is what the
 * contract refine and the mint assertion below rely on.
 */
export function canonicalizeIdentityValue(kind: IdentityKind, value: string): string {
  const trimmed = value.trim();
  return CASE_FOLDED_IDENTITY_KINDS.has(kind) ? trimmed.toLowerCase() : trimmed;
}

// A DNS label and the GitHub login/owner grammar, shared by the format regexes
// below. `GITHUB_HANDLE`: 1–39 chars, alphanumeric with single INTERNAL hyphens
// only (a hyphen is allowed only when immediately followed by an alphanumeric, so
// no leading/trailing/consecutive hyphens). `DNS_LABEL`: 1–63 chars, no
// leading/trailing hyphen. Both are written without lookbehind so they parse on
// every JS engine.
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const GITHUB_HANDLE = "[a-z\\d](?:[a-z\\d]|-(?=[a-z\\d])){0,38}";
// Final DNS label: same label grammar, but must contain at least one letter. This
// rejects all-numeric pseudo-TLDs (`example.123`) while still accepting punycoded
// IDN labels (`xn--...`).
const DNS_TLD = `(?=[a-z0-9-]*[a-z])${DNS_LABEL}`;
// A DNS hostname: ≥2 labels (must carry a TLD), each per `DNS_LABEL` (so no empty
// label, no leading/trailing hyphen — rejects `bad..com`, `-bad`, `bad-`), ≤253
// chars total, and a non-numeric TLD. The lookahead bounds only the host (`[^@]`,
// since a hostname never contains `@`), so the same constant validates a
// standalone `domain` AND the part after `@` in an `email`.
const HOSTNAME = `(?=[^@]{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*\\.${DNS_TLD}`;

/**
 * Per-kind VALUE FORMAT validators (D2/D3). Non-empty + canonical (above) is the
 * FLOOR, not the whole contract: a kind whose value has a well-defined shape must
 * also MATCH that shape before it becomes a permanent `ent_*` content-address.
 * Without this, `{ kind: "email", value: "not-an-email" }` or `{ kind:
 * "github_user_id", value: "abc" }` mints a permanent anchor from garbage that no
 * later real value can ever reconcile with — the same split-brain class as the
 * canonicalization gap, one rung lower. Enforced at the contract boundary
 * (`identityRefSchema`) AND mirrored at the mint chokepoint (`computeStableEntityId`),
 * same fail-loud posture as the whitespace/canonical checks.
 *
 * Only kinds with an UNAMBIGUOUS, spec- or contract-defined shape are listed.
 * Provider-OPAQUE ids with no committed format and no reducer yet (`slack_id`,
 * `notion_user_id`, `google_directory_id`, `phone`) are deliberately left at the
 * non-empty+canonical floor — guessing their shape risks rejecting a legitimate
 * value, and folding/validating an opaque id can corrupt a real distinct one.
 * Their reducer registers a format HERE when it lands (the same "a new reducer
 * registers first" precedent as `OBSERVATION_KINDS_BY_SOURCE`). Values are assumed
 * already canonical for their kind (lowercased where case-folded), so the
 * case-folded patterns are written lowercase-only.
 */
const IDENTITY_VALUE_FORMATS: Partial<Record<IdentityKind, RegExp>> = {
  // Pragmatic, not full RFC 5322, but the DOMAIN is validated for real (shared
  // `HOSTNAME`): a local part with no whitespace / `@` / control chars (C0 +
  // DEL — so `a\x00b@x.com` can't anchor), then `@`, then a true dotted hostname.
  // Rejects "not-an-email", "a@b" (no TLD), and the near-miss domains a loose
  // `[^\s@]+\.[^\s@]+` waved through — `a@-bad.com`, `a@bad..com`, `a@bad.com-`.
  email: new RegExp(`^[^\\s@\\x00-\\x1f\\x7f]+@${HOSTNAME}$`),
  // DNS hostname: ≥2 labels (must carry a TLD) and ≤253 chars total.
  domain: new RegExp(`^${HOSTNAME}$`),
  // GitHub username rules (lowercased).
  github_login: new RegExp(`^${GITHUB_HANDLE}$`),
  // Immutable provider numeric ids — a positive integer with no leading zero.
  github_user_id: /^[1-9]\d*$/,
  github_repository_id: /^[1-9]\d*$/,
  // `owner/repo`: owner follows login rules; repo is `[a-z0-9._-]` (1–100) and may
  // not be exactly `.` or `..` (a path traversal, never a real repo name).
  github_repository_full_name: new RegExp(`^${GITHUB_HANDLE}/(?!\\.{1,2}$)[a-z0-9._-]{1,100}$`),
  // Generic provider object key for non-person `project` nodes (ADR-0062): the
  // `provider:kind:externalId` shape mirroring the `(provider, kind, external_id)`
  // native identity of an `integration_objects` row, so a bare token can't anchor a
  // project node (and semantically collide with a person handle). The P2/P3
  // reducer mints keys in this shape; `externalId` may itself contain colons.
  integration_object_key: /^[a-z0-9_-]+:[a-z0-9_-]+:.+$/,
};

/**
 * True iff `value` is a legal format for `kind` — or `kind` has no registered
 * format, in which case only the non-empty+canonical floor applies. Assumes
 * `value` is already canonical for the kind (run `canonicalizeIdentityValue`
 * first). The mint chokepoint and the contract boundary both gate on this.
 */
export function identityValueMatchesKind(kind: IdentityKind, value: string): boolean {
  const format = IDENTITY_VALUE_FORMATS[kind];
  return format ? format.test(value) : true;
}

export const identityRefSchema = z
  .object({
    kind: identityKindSchema,
    value: identityValueSchema,
  })
  .strict()
  // The value must already be in canonical form for its kind — the contract
  // boundary refuses a non-canonical identity (`Person@x.com`) rather than
  // silently folding it, mirroring the mint chokepoint's fail-loud posture
  // (`computeStableEntityId`): normalizing is the reducer's job (via
  // `canonicalizeIdentityValue`), and an un-normalized value reaching the schema
  // is a reducer bug that must surface, not get papered over into a second
  // address for the same identity. The original un-normalized form lives in
  // `observationParticipant.raw`, so nothing is lost by requiring this.
  .refine((r) => r.value === canonicalizeIdentityValue(r.kind, r.value), {
    error:
      "identity value must be canonical for its kind (e.g. lowercased email/domain/github handle)",
    path: ["value"],
  })
  // Beyond canonical, the value must MATCH its kind's format (a real email, a
  // numeric github id, an `owner/repo`, …) — a malformed value would otherwise
  // mint a permanent `ent_*` anchor from garbage. Kinds with no registered format
  // pass this (the floor still applies). See `identityValueMatchesKind`.
  .refine((r) => identityValueMatchesKind(r.kind, r.value), {
    error: "identity value is not a valid format for its kind",
    path: ["value"],
  });
export type IdentityRef = z.infer<typeof identityRefSchema>;

/**
 * The subject an observation is ABOUT. Almost always a cross-source identity (a
 * contact / org / repo). But `source='user'|'alfred_chat'` observations (D14) —
 * and the self-facts whose `FACT_ONTOLOGY` subject is `'user'` (timezone,
 * location, standing instructions, profile edits) — are about the user
 * themselves, who has no `IdentityRef` of their own (they are the axis the
 * graph is built around, not a node in it). `{ kind: 'user' }` is the only way
 * to express that subject without inventing a self-entity or smuggling the
 * meaning into `payload`. Mirrors `FACT_SUBJECT_KINDS` on the projection side.
 *
 * The `observations.subject_identity` column stays so named (renaming is a
 * migration; widening the jsonb `$type` is not) — read it as "subject" when the
 * kind is `user`.
 */
export const observationSubjectSchema = z.union([
  identityRefSchema,
  z.object({ kind: z.literal("user") }).strict(),
]);
export type ObservationSubject = z.infer<typeof observationSubjectSchema>;

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

/**
 * The single initiating ACTOR side of an event — the sender / organizer / PR or
 * commit author. Excluded from the fan-out audience count: one actor addressing
 * N others is a 1→N event, and counting the actor would inflate a true 1:1.
 * Closed, small set; everything else in the participant vocabulary is audience.
 */
const ACTOR_ROLES: ReadonlySet<ObservationParticipantRole> = new Set([
  "from",
  "organizer",
  "author",
]);

/**
 * Roles that are CONTRIBUTOR/authorship metadata, not fan-out audience and not
 * the initiating actor — a third bucket excluded from `recipientCount`. A
 * `committer` is whoever committed a commit, which on GitHub's merge/squash path
 * is the bot identity `web-flow` (or "GitHub") rather than a person the event
 * fans out to: counting it would make that bot a co-occurrence MAGNET linked to
 * everyone, and a 30-committer PR would read as a 30-person blast and have its
 * genuine collaboration co-occurrence suppressed under `FAN_OUT_CUTOFF`. It is
 * also the symmetric partner of `author` (already an actor) — the same
 * contributor class, so it shouldn't land on the opposite side of the audience
 * line. Kept SEPARATE from `ACTOR_ROLES` (a committer isn't the initiating actor
 * either) so the actor semantics stay clean; both sets are subtracted from the
 * audience below.
 */
const CONTRIBUTOR_ROLES: ReadonlySet<ObservationParticipantRole> = new Set(["committer"]);

/**
 * Roles `recipientCount` counts — the fan-out AUDIENCE: every co-occurrence-
 * bearing participant that is neither the initiating actor nor contributor
 * metadata. For email that is To/Cc/Bcc; for calendar, attendees; for GitHub,
 * the reviewers/assignees a PR fans out to (NOT committers — see
 * `CONTRIBUTOR_ROLES`). Defined as the COMPLEMENT of `ACTOR_ROLES ∪
 * CONTRIBUTOR_ROLES` (not a hand-listed allowlist) so a new audience role added
 * to `OBSERVATION_PARTICIPANT_ROLES` is counted automatically — otherwise every
 * future reducer (the P2 GitHub one first) would have to remember a separate
 * convention, and a 30-reviewer PR written with `recipientCount: 0` would slip
 * the fan-out rail. `items` may legitimately carry MORE rows than
 * `recipientCount` (it also holds the actor roles) or FEWER (a huge blast may
 * store `recipientCount: 50` while enumerating only a subset). So the only
 * direction the envelope can self-check is the one that catches the prod
 * corruption this design exists to kill: a reducer enumerating N audience
 * members but writing `recipientCount < N`, which would let an N-person blast
 * masquerade as a 1:1 and slip under `FAN_OUT_CUTOFF`.
 *
 * The lower bound counts DISTINCT recipient IDENTITIES, not raw rows — the fold
 * (and `FAN_OUT_CUTOFF`) reason about distinct recipient participants, so one
 * person appearing in both To and Cc, or a GitHub user who is both `reviewer`
 * and `assignee`, is one recipient. Counting rows would force a correct reducer
 * (`recipientCount = 1` distinct) to fail this refine and inflate the count to
 * pass — re-introducing exactly the per-reducer convention this rail removes.
 */
function distinctRecipientCount(items: readonly ObservationParticipant[]): number {
  const seen = new Set<string>();
  for (const p of items) {
    // Join with an escaped NUL (\u0000 — never a LITERAL NUL byte in source,
    // which turns this file binary to rg/grep and silently breaks plain-text
    // search on a core contract). NUL can't occur in a typed identity kind or a
    // normalized value, so it is an unambiguous separator that keeps
    // (kind:"email", value:"a") distinct from (kind:"email_a", value:"").
    if (RECIPIENT_ROLES.has(p.role)) seen.add(`${p.identity.kind}\u0000${p.identity.value}`);
  }
  return seen.size;
}
const RECIPIENT_ROLES: ReadonlySet<ObservationParticipantRole> = new Set(
  OBSERVATION_PARTICIPANT_ROLES.filter(
    (role) => !ACTOR_ROLES.has(role) && !CONTRIBUTOR_ROLES.has(role),
  ),
);

export const observationParticipantsSchema = z
  .object({
    items: z.array(observationParticipantSchema),
    /**
     * Total fan-out audience size (the cutoff signal). May exceed `items.length`
     * when the reducer truncates a blast's participant list; must never be LESS
     * than the DISTINCT recipient identities enumerated in `items` (the refine
     * below). The P1 fold derives fan-out as `max(recipientCount, |distinct
     * recipient identities|)` so a miswritten count can never push a real blast
     * back under the cutoff.
     */
    recipientCount: z.number().int().nonnegative(),
    listId: z.string().nullable().optional(),
  })
  .strict()
  .refine(({ items, recipientCount }) => recipientCount >= distinctRecipientCount(items), {
    error:
      "recipientCount must be >= the number of DISTINCT enumerated recipient identities (a blast can't masquerade as a 1:1 and bypass FAN_OUT_CUTOFF)",
    path: ["recipientCount"],
  });
export type ObservationParticipants = z.infer<typeof observationParticipantsSchema>;

export const observationPayloadSchema = jsonObjectSchema;
export type ObservationPayload = z.infer<typeof observationPayloadSchema>;

export const gmailEmailMessagePayloadSchema = z
  .object({
    provider: z.literal("gmail"),
    documentId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    accountId: z.string().min(1).nullable(),
    isSent: z.boolean(),
    subject: z.string().nullable(),
    subjectHash: z.string().min(1).nullable(),
    headers: z
      .object({
        messageId: z.string().min(1).nullable(),
        inReplyTo: z.string().min(1).nullable(),
        references: z.array(z.string().min(1)),
        listId: z.string().min(1).nullable(),
        replyTo: z.string().min(1).nullable(),
        deliveredTo: z.string().min(1).nullable(),
        autoSubmitted: z.string().min(1).nullable(),
        precedence: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();
export type GmailEmailMessagePayload = z.infer<typeof gmailEmailMessagePayloadSchema>;

const canonicalDomainSchema = identityValueSchema
  .refine((v) => v === canonicalizeIdentityValue("domain", v), {
    error: "domain must be canonical (lowercased, no surrounding whitespace)",
  })
  .refine((v) => identityValueMatchesKind("domain", v), {
    error: "domain must be a valid hostname",
  });

export const userOrgAffiliationPayloadSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .refine((v) => v === v.trim(), {
        error: "accountId must not have leading or trailing whitespace",
      }),
    accountEmail: z
      .string()
      .refine((v) => v === canonicalizeIdentityValue("email", v), {
        error: "accountEmail must be canonical (lowercased, no surrounding whitespace)",
      })
      .refine((v) => identityValueMatchesKind("email", v), {
        error: "accountEmail must be a valid email address",
      }),
    orgDomain: canonicalDomainSchema,
    verifiedHostedDomain: canonicalDomainSchema.nullable(),
    domainClass: domainClassSchema,
    status: z.enum(["connected", "disconnected"]),
    evidence: z.string().min(1).optional(),
  })
  .strict();
export type UserOrgAffiliationPayload = z.infer<typeof userOrgAffiliationPayloadSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Observation write boundary (HARD P1 GATE)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Byte caps for the two idempotency keys, mirroring the DB CHECKs
 * (`observations_family_key_nonempty` ≤ 512, `observations_evidence_hash_nonempty`
 * ≤ 256). Pinned here so a write that would trip the constraint is rejected at the
 * app boundary with a field-level message instead of surfacing as a raw 23514.
 */
export const MAX_FAMILY_KEY_BYTES = 512;
export const MAX_EVIDENCE_HASH_BYTES = 256;

/**
 * An idempotency-key string column (`family_key` / `evidence_hash`): non-empty,
 * no surrounding whitespace, bounded in UTF-8 bytes — the contract-side mirror of
 * the `length(...) > 0 AND octet_length(...) <= N AND ... !~ '^[[:space:]]|[[:space:]]$'`
 * DB rails. `trim()` covers the DB's `[[:space:]]` edge-whitespace check (and then
 * some — JS trims all Unicode whitespace), so a value that clears this clears the
 * DB constraint too.
 */
function boundedKeySchema(maxBytes: number, label: string) {
  return z
    .string()
    .min(1, { error: `${label} must be non-empty` })
    .refine((v) => v === v.trim(), {
      error: `${label} must not have leading or trailing whitespace`,
    })
    .refine((v) => UTF8_ENCODER.encode(v).byteLength <= maxBytes, {
      error: `${label} must be <= ${maxBytes} UTF-8 bytes`,
    });
}

/**
 * The ONE schema every observation write must pass before any `.insert(observations)`
 * (ADR-0067 P1 HARD GATE). The DB columns are deliberately bare `text`/`jsonb`
 * (app-boundary validation, not pg enums), so this parser — not the database — is
 * what stands between a reducer bug and a permanently-corrupt log. It composes the
 * pieces the schema comments name as its obligations:
 *
 *   - `source` × `kind` validated as a PAIR (`isObservationKindForSource`), closing
 *     the half-open vocabulary a `gmail` row carrying a `github_*` kind would slip;
 *   - `subjectIdentity` as an `ObservationSubject` (a canonical `IdentityRef` OR the
 *     `{ kind: "user" }` self-subject), `objectIdentity` as a canonical `IdentityRef`
 *     or null — both inherit the kind-specific FORMAT + canonicalization refines;
 *   - `participants` as the full envelope (its `recipientCount >= distinct
 *     recipients` refine guards `FAN_OUT_CUTOFF`); `payload` as a JSON object;
 *   - `familyKey` / `evidenceHash` non-empty, edge-whitespace-free, byte-bounded
 *     (mirrors the DB idempotency rails); `schemaVersion` / `reducerVersion` ≥ 1.
 *
 * `participants` and `payload` carry the same defaults as the DB columns so a
 * minimal reducer need not restate them. `supersedesObservationId` is the prior
 * active family member this row supersedes — its multi-hop cycle detection + the
 * CAS retry against `observations_no_fork_idx` stay the reducer's job (the writer
 * only performs the validated append + head upsert); the parser just types the
 * pointer.
 */
export const observationInsertSchema = z
  .object({
    userId: z.string().min(1),
    source: observationSourceSchema,
    kind: observationKindSchema,
    occurredAt: z.date(),
    familyKey: boundedKeySchema(MAX_FAMILY_KEY_BYTES, "familyKey"),
    evidenceHash: boundedKeySchema(MAX_EVIDENCE_HASH_BYTES, "evidenceHash"),
    subjectIdentity: observationSubjectSchema,
    objectIdentity: identityRefSchema.nullable().optional(),
    participants: observationParticipantsSchema.default({ items: [], recipientCount: 0 }),
    payload: observationPayloadSchema.default({}),
    schemaVersion: z.number().int().min(1).default(1),
    reducerVersion: z.number().int().min(1).default(1),
    supersedesObservationId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(({ source, kind }) => isObservationKindForSource(source, kind), {
    error: "observation kind is not valid for its source",
    path: ["kind"],
  })
  .superRefine(({ kind, payload, subjectIdentity }, ctx) => {
    if (kind === "email_message") {
      const parsed = gmailEmailMessagePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["payload", ...issue.path],
            message: issue.message,
          });
        }
      }
      return;
    }
    if (kind !== "user_org_affiliation") return;
    const parsed = userOrgAffiliationPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: ["payload", ...issue.path],
          message: issue.message,
        });
      }
      return;
    }
    if (subjectIdentity.kind !== "user") {
      ctx.addIssue({
        code: "custom",
        path: ["subjectIdentity"],
        message: "user_org_affiliation observations must be about the user",
      });
    }
    const expectedDomainClass = classifyEmailDomain({
      email: parsed.data.accountEmail,
      verifiedHostedDomain: parsed.data.verifiedHostedDomain,
    });
    if (expectedDomainClass !== parsed.data.domainClass) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "domainClass"],
        message: "domainClass must match accountEmail/verifiedHostedDomain classification",
      });
    }
    if (
      parsed.data.verifiedHostedDomain != null &&
      parsed.data.verifiedHostedDomain !== parsed.data.orgDomain
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "verifiedHostedDomain"],
        message: "verifiedHostedDomain must match orgDomain when present",
      });
    }
  });
/** Caller-facing input (pre-parse): defaulted fields are optional. */
export type ObservationInsertInput = z.input<typeof observationInsertSchema>;
/** Validated, defaults-applied observation ready to persist. */
export type ObservationInsert = z.infer<typeof observationInsertSchema>;

/**
 * UNCONDITIONALLY immutable PERSON/ACCOUNT ids — a stable per-account handle with
 * a committed value contract, so sharing one is always a hard cross-source bridge
 * between two people-observations (P2/P3 merge use). This is deliberately NOT the
 * same set as `identityAnchorRank`'s `providerAccountId` tier: that tier is an
 * anchor-STRENGTH bucket that also holds `domain` (an org, shared by many people
 * — never a person bridge), `slack_id`/`notion_user_id` (opaque until their
 * reducers register value formats), and `github_repository_id` /
 * `integration_object_key` (immutable, but they anchor `repository`/`project`
 * nodes, not accounts). Keep the two distinct; don't widen this list to the
 * anchor tier or a repo/org/opaque id would falsely bridge two people.
 *
 * NOT the exhaustive merge-policy set — `google_directory_id` is ALSO a hard
 * bridge, but only when `verified` (D2/D3), so it can't live in a bare list.
 * Email is a hard bridge too, but it is not an opaque immutable account id. P2/P3
 * merge code must gate on `isHardPersonBridge`, never this list directly, or it
 * will miss email / verified Directory identities and over-merge future opaque ids.
 */
export const IMMUTABLE_ACCOUNT_ID_KINDS = [
  "github_user_id",
] as const satisfies readonly IdentityKind[];

export interface AccountBridgeInput {
  readonly kind: IdentityKind;
  /** Mirrors `entity_identities.verified` — gates the directory case (D2/D3). */
  readonly verified?: boolean;
}

/**
 * True iff sharing this opaque/directory account identity is a hard person bridge
 * for P2/P3 auto-merge (D3). The unconditional account ids bridge whenever
 * present; `google_directory_id` bridges ONLY when `verified`, exactly as it only
 * anchors at the directory tier when verified in `identityAnchorRank` (an
 * unverified Directory row is a weaker signal that must not auto-merge two
 * people). Email is a hard bridge too, but it is not an opaque account id; use
 * `isHardPersonBridge` for the complete merge-policy predicate.
 */
export function isImmutableAccountBridge({ kind, verified }: AccountBridgeInput): boolean {
  if ((IMMUTABLE_ACCOUNT_ID_KINDS as readonly IdentityKind[]).includes(kind)) return true;
  return kind === "google_directory_id" && verified === true;
}

/** Complete P2/P3 hard person-bridge predicate (D3): email OR a gated account id. */
export function isHardPersonBridge(input: AccountBridgeInput): boolean {
  return input.kind === "email" || isImmutableAccountBridge(input);
}

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
    // Immutable provider object ids — the anchor for non-person nodes
    // (`repository` / `project`). They never bridge across sources, so the tier
    // only matters for the single-identity content-address; they sit with the
    // other immutable provider ids rather than the renamable-handle tier.
    case "github_repository_id":
    case "integration_object_key":
      return IDENTITY_ANCHOR_TIER.providerAccountId;
    case "github_login":
    // `owner/repo` is renamable/transferable, exactly like a GitHub login — a
    // weaker anchor than the immutable numeric repo id above.
    case "github_repository_full_name":
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
 * lost — but `group` / `service` / `repository` / `project` / `unknown` are
 * NEVER person-significance-scored (this is the dist-list HARD gate that fixes
 * the live `'Anthropic' via Engineering`-as-#1-person bug).
 *
 * `unknown` is the deterministic low-confidence bucket: keep the stable node
 * and provenance, but withhold person scoring + edge promotion until a later
 * projection version has stronger evidence.
 */
export const ENTITY_NODE_KINDS = [
  "person",
  "organization",
  "group",
  "service",
  "repository",
  "project",
  "unknown",
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
  "unknown",
] as const satisfies readonly EntityNodeKind[];

export function isPersonScorable(kind: EntityNodeKind): boolean {
  return kind === "person";
}

export const ENTITY_KIND_RESEARCH_STATUS = [
  "not_needed",
  "not_started",
  "pending",
  "completed",
  "failed",
] as const;
export const entityKindResearchStatusSchema = z.enum(ENTITY_KIND_RESEARCH_STATUS);
export type EntityKindResearchStatus = (typeof ENTITY_KIND_RESEARCH_STATUS)[number];

/**
 * Versioned profile-kind classifier output, persisted inside projection
 * provenance. This is deliberately model/source-agnostic: deterministic folds
 * write evidence codes, while later enrichment can update `researchStatus`
 * without inventing a second provenance shape.
 */
export const entityKindClassificationSchema = z
  .object({
    kind: entityNodeKindSchema,
    confidence: z.number().min(0).max(1),
    bestGuess: entityNodeKindSchema.exclude(["unknown"]).optional(),
    evidenceCodes: z.array(z.string().min(1)),
    researchStatus: entityKindResearchStatusSchema.default("not_needed"),
  })
  .strict();
export type EntityKindClassification = z.infer<typeof entityKindClassificationSchema>;

export const projectionProvenanceSchema = z
  .object({
    observationIds: z.array(z.string()).optional(),
    familyKeys: z.array(z.string()).optional(),
    classification: entityKindClassificationSchema.optional(),
  })
  .catchall(jsonValueSchema);
export type ProjectionProvenance = z.infer<typeof projectionProvenanceSchema>;

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
 *
 * The count the P1 fold compares against this is `max(participants.recipientCount,
 * |distinct recipient participants in items|)`, NOT `recipientCount` alone — the
 * envelope refine guarantees `recipientCount` is never less than the enumerated
 * recipients, so neither a truncated `items` nor an under-written count can
 * push a real blast back under the cutoff.
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
 * observations across at least this many distinct event families. Source folds
 * may add stricter diversity keys when their event family grain is smaller than
 * the real interaction context. For example, Gmail uses message-grain families
 * for idempotent supersession, then separately requires thread diversity before
 * promoting a collaborator edge.
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
 *
 * NOTE — these keys are fold-derived INTERACTION CLASSES, not the raw
 * `OBSERVATION_KINDS` vocabulary (`gmail`'s one kind `email_message` fans out
 * into `gmail_reply`/`gmail_direct`/`gmail_cc`/`gmail_blast` here). So the
 * `github_pull_request` observation kind has no 1:1 key on purpose: P2 owns the
 * decision of which class a PR-open contributes to (author↔reviewer/assignee
 * co-occurrence) versus what it only emits as an object edge (`authored_by`,
 * D9). It is registered as a person-co-occurrence class at P2, not dropped — do
 * not add a `github_pull_request` weight here before that fold lands.
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

/**
 * TIME-INVARIANT significance components only (D6/D13). The final score is
 * `base(components) * recency(asOf)` computed at READ time, and the projection
 * checksum runs over these components — so anything wall-clock-derived must stay
 * OUT of here or the checksum stops being deterministic across replays. Recency
 * is NOT a component: `lastSeenAt` is a first-class column on `entity_profiles`
 * (and `entity_co_occurrence`), the single source of truth read at scoring time.
 */
export const significanceComponentsSchema = z
  .object({
    volume: z.number().nonnegative().optional(),
    reciprocity: z.number().min(0).max(1).optional(),
    sameOrg: z.number().min(0).max(1).optional(),
    interactionWeight: z.number().nonnegative().optional(),
    coOccurrenceWeight: z.number().nonnegative().optional(),
    topObservationIds: z.array(z.string()).optional(),
  })
  .strict();
export type SignificanceComponents = z.infer<typeof significanceComponentsSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Projection run bookkeeping
// ───────────────────────────────────────────────────────────────────────────

/**
 * The canonical projection name for the user-model graph (the `entity_profiles` /
 * `entity_edges` / `entity_co_occurrence` triple). `projection_runs` is GENERIC
 * (P4's `user_facts` projection reuses it under its own name), so the writer,
 * the reader, and every `projection_*` row bind to this one string rather than
 * scattering the literal — a typo would silently strand a run under an unread name.
 */
export const USER_MODEL_PROJECTION_NAME = "user-model";

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
 * Registered durable fact-types (D8, #330). A `user_facts.key` must validate
 * against this at the app boundary. This is the ONE canonical fact-key registry
 * — `CANONICAL_FACT_KEYS` below is derived from it, not declared in parallel
 * (the #330 "no second registry" rule). Transient document content (passcodes,
 * alarm names, incident timestamps) is NOT a fact-type — it stays in the
 * document / `memory_chunk`, never auto-confirmed as a fact. `standing_instruction`
 * is reserved and governed by `standing-instructions.ts`, not folded as an
 * ontology value here — so the `user_facts.key` column gate is `isUserFactKey`
 * (ontology ∪ the standing key), NOT `isFactKey` (durable fact-types only).
 *
 * Keys are durable CONCEPTS, not read-DTO labels: currentness is represented by
 * `status` + validity windows, so the storage key is `employer`, never
 * `current_company` (the read API still exposes `currentCompany` by mapping from
 * it — see `read_user_context`). Legacy / producer spellings
 * (`current_company`, `company`, `name`, `personal_website`, …) are mapped onto
 * these keys by `FACT_KEY_ALIASES` + `canonicalizeFactKey`, never stored as
 * parallel truths.
 */
export const FACT_ONTOLOGY = {
  // identity
  full_name: { subject: "any", description: "Full name." },
  first_name: { subject: "any", description: "Given name." },
  last_name: { subject: "any", description: "Family name." },
  user_nickname: { subject: "user", description: "What the user likes to be called." },
  bio_summary: { subject: "any", description: "Short biography / who they are (paragraph)." },
  birthday: { subject: "any", description: "Date of birth (ISO date or month-day)." },
  marital_status: { subject: "any", description: "Marital status (married, single, …)." },
  spouse_name: { subject: "any", description: "Spouse / partner name." },
  family_summary: { subject: "any", description: "Short summary of family (paragraph)." },
  notable_relations: {
    subject: "any",
    description: "Public-figure relations and why they're notable (paragraph).",
  },
  // work
  work_summary: { subject: "any", description: "What they do / current work (paragraph)." },
  employer: { subject: "any", description: "Organization the subject works for." },
  job_title: { subject: "any", description: "Role / title." },
  team: { subject: "any", description: "Team or org unit." },
  manager: { subject: "any", description: "Who the subject reports to (entity ref)." },
  // location
  location: { subject: "any", description: "City / region they're based in." },
  home_city: { subject: "any", description: "Home city." },
  home_country: { subject: "any", description: "Home country." },
  timezone: { subject: "user", description: "IANA timezone." },
  // online presence
  personal_site: { subject: "any", description: "Personal website URL." },
  github_username: { subject: "any", description: "GitHub login." },
  twitter_handle: { subject: "any", description: "Twitter / X handle." },
  linkedin_url: { subject: "any", description: "LinkedIn profile URL." },
} as const satisfies Record<string, FactTypeDef>;
export type FactKey = keyof typeof FACT_ONTOLOGY;

export function isFactKey(key: string): key is FactKey {
  return Object.prototype.hasOwnProperty.call(FACT_ONTOLOGY, key);
}

/**
 * The exact canonical identity/profile fact keys — derived from the ONE
 * registry (`FACT_ONTOLOGY`), never a parallel list. The order tracks the
 * registry declaration order.
 */
export const CANONICAL_FACT_KEYS = Object.keys(FACT_ONTOLOGY) as readonly FactKey[];

/**
 * Open-ended fact-key prefixes (a key is `<prefix><suffix>`):
 *   - `relationship:<email>` — the user's relationship to that person.
 *   - `pref:<name>`          — a durable preference.
 * The suffix is validated/normalized per-prefix by `canonicalizeFactKey`.
 */
export const RELATIONSHIP_FACT_PREFIX = "relationship:";
export const PREF_FACT_PREFIX = "pref:";
export const CANONICAL_FACT_PREFIXES = [RELATIONSHIP_FACT_PREFIX, PREF_FACT_PREFIX] as const;

/**
 * EXPLICIT legacy / producer key-spelling map → canonical key. This is a
 * compatibility shim for the spellings actually observed in producers
 * (`cold-start/extract.ts`, `extraction.ts`) and in live dev rows — NOT a
 * fuzzy/semantic guesser and NOT a migration dumping ground. Near-misses that
 * are NOT listed (`website`, `url`, `homepage`, `company_url`) stay rejected as
 * `unknown_key`. Every target MUST be a real canonical key (the `satisfies`
 * enforces it). Consumed by `canonicalizeFactKey` before any dedup/conflict
 * check, for ALL sources (aliasing prevents `company`/`current_company`/
 * `employer` coexisting as separate truths).
 */
export const FACT_KEY_ALIASES = {
  current_company: "employer",
  company: "employer",
  company_name: "employer",
  current_role: "job_title",
  role: "job_title",
  current_work: "work_summary",
  current_location: "location",
  name: "full_name",
  personal_website: "personal_site",
} as const satisfies Record<string, FactKey>;
export type FactKeyAlias = keyof typeof FACT_KEY_ALIASES;

export function isFactKeyAlias(key: string): key is FactKeyAlias {
  return Object.prototype.hasOwnProperty.call(FACT_KEY_ALIASES, key);
}

/**
 * The result of canonicalizing a raw fact key. A canonical key passes through
 * (`wasAlias:false`); a listed alias or a re-normalized open key is mapped
 * (`wasAlias:true`, carrying the original for provenance); anything unknown is
 * rejected. This is a pure key-NAME canonicalizer — it never inspects the value
 * and never makes a trust/source decision (that is `fact-policy.ts`).
 */
export type CanonicalizeFactKeyResult =
  | { ok: true; key: string; wasAlias: false }
  | { ok: true; key: string; wasAlias: true; originalKey: string }
  | { ok: false; reason: "unknown_key" };

/**
 * Canonicalize a `user_facts` key onto the one ontology BEFORE dedup/conflict.
 *
 *  - Exact canonical key → passes through unchanged.
 *  - Listed `FACT_KEY_ALIASES` spelling → mapped to its canonical key.
 *  - `relationship:<email>` → email suffix trimmed + lowercased; an unparseable
 *    (non-email) suffix is rejected (`relationship:github.com`, a display name).
 *  - `pref:<name>` → suffix trimmed; an empty suffix is rejected.
 *  - Anything else → `{ ok:false, reason:"unknown_key" }`.
 *
 * `wasAlias` is true exactly when the canonical key differs from the raw input
 * (a spelling alias OR a re-normalized open key), so callers can record
 * `originalKey` for drift provenance.
 */
export function canonicalizeFactKey(rawKey: string): CanonicalizeFactKeyResult {
  const key = rawKey.trim();
  if (isFactKey(key)) {
    return key === rawKey
      ? { ok: true, key, wasAlias: false }
      : { ok: true, key, wasAlias: true, originalKey: rawKey };
  }
  if (isFactKeyAlias(key)) {
    return { ok: true, key: FACT_KEY_ALIASES[key], wasAlias: true, originalKey: rawKey };
  }
  if (key.startsWith(RELATIONSHIP_FACT_PREFIX)) {
    const email = key.slice(RELATIONSHIP_FACT_PREFIX.length).trim().toLowerCase();
    if (!email || !identityValueMatchesKind("email", email)) {
      return { ok: false, reason: "unknown_key" };
    }
    const canonical = `${RELATIONSHIP_FACT_PREFIX}${email}`;
    return canonical === rawKey
      ? { ok: true, key: canonical, wasAlias: false }
      : { ok: true, key: canonical, wasAlias: true, originalKey: rawKey };
  }
  if (key.startsWith(PREF_FACT_PREFIX)) {
    const name = key.slice(PREF_FACT_PREFIX.length).trim();
    if (!name) return { ok: false, reason: "unknown_key" };
    const canonical = `${PREF_FACT_PREFIX}${name}`;
    return canonical === rawKey
      ? { ok: true, key: canonical, wasAlias: false }
      : { ok: true, key: canonical, wasAlias: true, originalKey: rawKey };
  }
  return { ok: false, reason: "unknown_key" };
}

/**
 * Every legal `user_facts.key` — the boundary gate the P4 fact projection
 * validates against. It is NOT just `FACT_ONTOLOGY`: `standing_instruction`
 * (governed by `standing-instructions.ts`, ADR-0058) is a first-class
 * `user_facts.key` that deliberately lives OUTSIDE the durable-fact ontology
 * (its `value` is a structured directive, not a fact-type). The plan migrates
 * standing instructions into `source='user'` observations that project back
 * into `user_facts`, so a gate that checked `isFactKey` alone would reject the
 * very rows it must accept. Validate column writes with THIS, classify
 * fact-types with `isFactKey`.
 */
export type UserFactKey = FactKey | typeof STANDING_INSTRUCTION_KEY;

export function isUserFactKey(key: string): key is UserFactKey {
  return isFactKey(key) || key === STANDING_INSTRUCTION_KEY;
}
