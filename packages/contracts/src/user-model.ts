/**
 * Closed vocabularies for the user-model observation log and its projections (ADR-0067).
 * Postgres stores plain text; these registries validate it at the app boundary.
 * The `ent_*` id HMAC needs a server secret, so it lives in `@alfred/db` (`computeStableEntityId`).
 * Names differ from the legacy `entities` graph (`ENTITY_KINDS`), which coexists until cutover (D10).
 */

import { z } from "zod";
import { HOSTNAME } from "./hostname";
import { classifyEmailDomain, domainClassSchema } from "./identity-affiliation";
import { STANDING_INSTRUCTION_KEY } from "./standing-instructions";

// ───────────────────────────────────────────────────────────────────────────
// Observation sources + precedence (D1, D14)
// ───────────────────────────────────────────────────────────────────────────

/** Kinds that `user` and `alfred_chat` both emit (D14). */
const USER_AUTHORED_KINDS = [
  "user_standing_instruction",
  "user_correction",
  "user_confirmation",
  "user_rejection",
  "user_profile_edit",
] as const;

/** One reducer's precedence and the evidence kinds it may emit. */
interface ObservationReducerEntry {
  /**
   * Fold precedence (D14). Lower wins over any recency; recency breaks ties.
   * An integration may propose a fact but never overwrite a user correction.
   */
  readonly rank: number;
  /** Evidence kinds this source may emit (D4/D15). */
  readonly kinds: readonly [string, ...string[]];
  /** Identity kinds this source may write to `entity_identities` (D2/D3). Empty means none. */
  readonly identityKinds: readonly string[];
}

/**
 * Every observation reducer, keyed by its source. The tables below derive from this record.
 * Register a source only in the change that lands its first write.
 */
export const OBSERVATION_REDUCERS = {
  /** A `/settings` edit or another explicit user statement. */
  user: { rank: 0, kinds: USER_AUTHORED_KINDS, identityKinds: [] },
  /** The same statements, captured from a chat thread. */
  alfred_chat: { rank: 1, kinds: USER_AUTHORED_KINDS, identityKinds: [] },
  /** Gmail messages. Its `domain` org nodes are nodes only, so `domain` stays forward. */
  gmail: { rank: 2, kinds: ["email_message"], identityKinds: ["email"] },
  /** The connected Google account asserts the user's org domain (ADR-0080 §4a). Not a Gmail event. */
  google_account: { rank: 2, kinds: ["user_org_affiliation"], identityKinds: [] },
} as const satisfies Record<string, ObservationReducerEntry>;

export type ObservationSource = keyof typeof OBSERVATION_REDUCERS;

export const OBSERVATION_SOURCES: readonly ObservationSource[] =
  // SAFETY: a non-indexed literal's keys are exactly its `keyof`.
  Object.keys(OBSERVATION_REDUCERS) as ObservationSource[];

export const observationSourceSchema = z.enum(OBSERVATION_SOURCES);

export const OBSERVATION_SOURCE_RANK: {
  readonly [S in ObservationSource]: (typeof OBSERVATION_REDUCERS)[S]["rank"];
} =
  // SAFETY: the pairs come from `OBSERVATION_SOURCES`, each with its own reducer's rank.
  Object.fromEntries(
    OBSERVATION_SOURCES.map((source) => [source, OBSERVATION_REDUCERS[source].rank]),
  ) as { readonly [S in ObservationSource]: (typeof OBSERVATION_REDUCERS)[S]["rank"] };

/** A kind is legal only for the source whose reducer emits it (D1/D15). */
export const OBSERVATION_KINDS_BY_SOURCE: {
  readonly [S in ObservationSource]: (typeof OBSERVATION_REDUCERS)[S]["kinds"];
} =
  // SAFETY: same shape argument as `OBSERVATION_SOURCE_RANK` above.
  Object.fromEntries(
    OBSERVATION_SOURCES.map((source) => [source, OBSERVATION_REDUCERS[source].kinds]),
  ) as { readonly [S in ObservationSource]: (typeof OBSERVATION_REDUCERS)[S]["kinds"] };

export type ObservationKind = (typeof OBSERVATION_REDUCERS)[ObservationSource]["kinds"][number];

export const OBSERVATION_KINDS: readonly ObservationKind[] = [
  ...new Set(OBSERVATION_SOURCES.flatMap((source) => OBSERVATION_REDUCERS[source].kinds)),
];

export const observationKindSchema = z.enum(OBSERVATION_KINDS);

export function isObservationKindForSource(
  source: ObservationSource,
  kind: ObservationKind,
): boolean {
  const kinds: readonly ObservationKind[] = OBSERVATION_KINDS_BY_SOURCE[source];

  return kinds.includes(kind);
}

/** Validates `source` and `kind` as a pair. `observationInsertSchema` composes it. */
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
 * Identity kinds some reducer may write to `entity_identities` (the registered half).
 * `IdentityKind` adds the forward half: legal in an `IdentityRef`, not yet writable as a row.
 */
export type EntityIdentityKind =
  (typeof OBSERVATION_REDUCERS)[ObservationSource]["identityKinds"][number];

const ENTITY_IDENTITY_KINDS: readonly EntityIdentityKind[] = [
  ...new Set(OBSERVATION_SOURCES.flatMap((source) => OBSERVATION_REDUCERS[source].identityKinds)),
];

const entityIdentityKindSchema = z.enum(ENTITY_IDENTITY_KINDS);

/**
 * Identity kinds with no writing reducer yet. A reducer that starts to write one
 * moves it to its own `identityKinds` in the same change.
 */
const FORWARD_IDENTITY_KINDS = [
  "domain",
  "github_login",
  "github_user_id",
  "slack_id",
  "notion_user_id",
  "google_directory_id",
  "phone",
  "github_repository_id",
  "github_repository_full_name",
  "integration_object_key",
] as const;

type ForwardIdentityKind = (typeof FORWARD_IDENTITY_KINDS)[number];

export type IdentityKind = EntityIdentityKind | ForwardIdentityKind;

// Fails to compile while a kind sits in both halves.
const UNREGISTERED_FORWARD_IDENTITY_KINDS: readonly Exclude<
  ForwardIdentityKind,
  EntityIdentityKind
>[] = FORWARD_IDENTITY_KINDS;

export const IDENTITY_KINDS: readonly IdentityKind[] = [
  ...ENTITY_IDENTITY_KINDS,
  ...UNREGISTERED_FORWARD_IDENTITY_KINDS,
];

export const identityKindSchema = z.enum(IDENTITY_KINDS);

export function isEntityIdentityKind(kind: IdentityKind): kind is EntityIdentityKind {
  const kinds: readonly IdentityKind[] = ENTITY_IDENTITY_KINDS;

  return kinds.includes(kind);
}

function isEntityIdentityKindForSource(source: ObservationSource, kind: IdentityKind): boolean {
  const kinds: readonly IdentityKind[] = OBSERVATION_REDUCERS[source].identityKinds;

  return kinds.includes(kind);
}

/** Rejects a forward kind, or a kind that another source mints. `recordEntityIdentity` parses it. */
export const entityIdentitySourceKindSchema = z
  .object({
    source: observationSourceSchema,
    kind: entityIdentityKindSchema,
  })
  .refine(({ source, kind }) => isEntityIdentityKindForSource(source, kind), {
    error: "identity kind is not minted by its source",
    path: ["kind"],
  });

export const MAX_IDENTITY_VALUE_BYTES = 1024;

const UTF8_ENCODER = new TextEncoder();

/**
 * Same rules as `computeStableEntityId` and `entity_identities.value`, so a valid
 * observation cannot fail later at projection.
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
 * Case-insensitive kinds, lowercased before dedup and minting.
 * Opaque provider ids (`slack_id`) are case-sensitive, so other kinds stay as they are.
 */
const CASE_FOLDED_IDENTITY_KINDS: ReadonlySet<IdentityKind> = new Set([
  "email",
  "domain",
  "github_login",
  "github_repository_full_name",
]);

/**
 * The one normalization for an identity value (D2). Every reducer must use it,
 * or one identity mints two `ent_*` ids. Idempotent; the canonical checks rely on that.
 */
export function canonicalizeIdentityValue(kind: IdentityKind, value: string): string {
  const trimmed = value.trim();

  return CASE_FOLDED_IDENTITY_KINDS.has(kind) ? trimmed.toLowerCase() : trimmed;
}

// GitHub login: 1 to 39 alphanumerics, single internal hyphens only. No lookbehind, for older engines.
const GITHUB_HANDLE = "[a-z\\d](?:[a-z\\d]|-(?=[a-z\\d])){0,38}";

/**
 * Value formats per kind (D2/D3). A malformed value would mint a permanent id no real value can match.
 * Opaque ids with no known format (`slack_id`, `phone`) are not listed, so a guess cannot reject real values.
 * Patterns are lowercase because values arrive canonical.
 */
const IDENTITY_VALUE_FORMATS = {
  // Loose local part (no whitespace, `@`, or control chars), strict hostname.
  email: new RegExp(`^[^\\s@\\x00-\\x1f\\x7f]+@${HOSTNAME}$`),
  domain: new RegExp(`^${HOSTNAME}$`),
  github_login: new RegExp(`^${GITHUB_HANDLE}$`),
  // Positive integer, no leading zero.
  github_user_id: /^[1-9]\d*$/,
  github_repository_id: /^[1-9]\d*$/,
  // Repo name must not be `.` or `..`.
  github_repository_full_name: new RegExp(`^${GITHUB_HANDLE}/(?!\\.{1,2}$)[a-z0-9._-]{1,100}$`),
  // `provider:kind:externalId` (ADR-0062). `externalId` may contain colons.
  integration_object_key: /^[a-z0-9_-]+:[a-z0-9_-]+:.+$/,
} satisfies Partial<Record<IdentityKind, RegExp>>;

/** True if `value` matches the format for `kind`, or `kind` has no format. Expects a canonical value. */
export function identityValueMatchesKind(kind: IdentityKind, value: string): boolean {
  const format = Object.entries(IDENTITY_VALUE_FORMATS).find(([k]) => k === kind)?.[1];

  return format ? format.test(value) : true;
}

export const identityRefSchema = z
  .object({
    kind: identityKindSchema,
    value: identityValueSchema,
  })
  .strict()
  // Reject, do not fold: a non-canonical value is a reducer bug.
  // The raw form lives in `ObservationParticipant.raw`.
  .refine((r) => r.value === canonicalizeIdentityValue(r.kind, r.value), {
    error:
      "identity value must be canonical for its kind (e.g. lowercased email/domain/github handle)",
    path: ["value"],
  })
  .refine((r) => identityValueMatchesKind(r.kind, r.value), {
    error: "identity value is not a valid format for its kind",
    path: ["value"],
  });

export type IdentityRef = z.infer<typeof identityRefSchema>;

/**
 * What an observation is about: an identity, or `{ kind: "user" }` for the user, who has no `IdentityRef`.
 * Stored in the `observations.subject_identity` column.
 */
export const observationSubjectSchema = z.union([
  identityRefSchema,
  z.object({ kind: z.literal("user") }).strict(),
]);

export type ObservationSubject = z.infer<typeof observationSubjectSchema>;

export type JsonPrimitive = string | number | boolean | null;

/**
 * Exactly what `jsonValueSchema` accepts. Keep them in step. No `undefined` values,
 * so a type with optional properties does not assign here. Omit the key instead.
 */
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

/** The one actor who starts an event. Not counted as audience, or a 1:1 would read as 1:2. */
const ACTOR_ROLES: ReadonlySet<ObservationParticipantRole> = new Set([
  "from",
  "organizer",
  "author",
]);

/**
 * Neither actor nor audience. On a GitHub merge the committer is the `web-flow` bot;
 * as audience it would link to everyone.
 */
const CONTRIBUTOR_ROLES: ReadonlySet<ObservationParticipantRole> = new Set(["committer"]);

/**
 * Distinct recipient identities in `items`. One person in both To and Cc counts once.
 * The lower bound for `recipientCount`, so a blast cannot pass as a 1:1.
 */
function distinctRecipientCount(items: readonly ObservationParticipant[]): number {
  const seen = new Set<string>();

  for (const p of items) {
    // NUL cannot occur in a kind or value, so it is a safe separator.
    // Keep it escaped: a literal NUL byte makes grep treat this file as binary.
    if (RECIPIENT_ROLES.has(p.role)) seen.add(`${p.identity.kind}\u0000${p.identity.value}`);
  }

  return seen.size;
}

// Audience is every other role, so a new role counts by default.
const RECIPIENT_ROLES: ReadonlySet<ObservationParticipantRole> = new Set(
  OBSERVATION_PARTICIPANT_ROLES.filter(
    (role) => !ACTOR_ROLES.has(role) && !CONTRIBUTOR_ROLES.has(role),
  ),
);

export const observationParticipantsSchema = z
  .object({
    items: z.array(observationParticipantSchema),
    /** Total audience size. May exceed `items` when the list is truncated, never fewer distinct recipients. */
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

export type ObservationPayload = z.infer<typeof jsonObjectSchema>;

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
        listUnsubscribe: z.string().min(1).nullable(),
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
// Observation write boundary
// ───────────────────────────────────────────────────────────────────────────

/** Same caps as the DB CHECKs, so a bad key fails here with a field message, not a raw 23514. */
export const MAX_FAMILY_KEY_BYTES = 512;

export const MAX_EVIDENCE_HASH_BYTES = 256;

/** Mirrors the DB CHECK on `family_key` / `evidence_hash`. `trim()` is stricter than `[[:space:]]`. */
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
 * Every observation write parses this first (ADR-0067 P1). The DB columns are plain
 * text and jsonb, so this is the only guard against a corrupt log.
 * Cycle checks on `supersedesObservationId` stay with the reducer.
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
    payload: jsonObjectSchema.default({}),
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

export type ObservationInsertInput = z.input<typeof observationInsertSchema>;

export type ObservationInsert = z.infer<typeof observationInsertSchema>;

/**
 * Immutable account ids: sharing one always links two people (D3).
 * Not the `providerAccountId` anchor tier, which also holds orgs and repos.
 * Merge code must call `isHardPersonBridge`, not read this list.
 */
export const IMMUTABLE_ACCOUNT_ID_KINDS = [
  "github_user_id",
] as const satisfies readonly IdentityKind[];

export interface AccountBridgeInput {
  readonly kind: IdentityKind;
  /** `entity_identities.verified`. Gates `google_directory_id` (D2/D3). */
  readonly verified?: boolean;
}

/** An immutable account id, or a verified `google_directory_id`. Excludes email. */
export function isImmutableAccountBridge({ kind, verified }: AccountBridgeInput): boolean {
  // SAFETY: widening to `IdentityKind[]` only lets `.includes` accept `kind`; every member is one.
  if ((IMMUTABLE_ACCOUNT_ID_KINDS as readonly IdentityKind[]).includes(kind)) return true;

  return kind === "google_directory_id" && verified === true;
}

/** The complete rule for when a shared identity links two people (D3). */
export function isHardPersonBridge(input: AccountBridgeInput): boolean {
  return input.kind === "email" || isImmutableAccountBridge(input);
}

/**
 * Anchor strength (D2/D3). Lower wins. The best anchor seeds the `ent_*` id and survives a merge.
 * The fold breaks ties: earliest `first_seen_at`, then value, then entity id.
 */
export const IDENTITY_ANCHOR_TIER = {
  /** User-pinned merge target / explicit user correction. */
  userPinned: 1,
  /** Verified first-party directory identity (Google Workspace). */
  directoryVerified: 2,
  email: 3,
  /** Provider immutable account ids + org domain. */
  providerAccountId: 4,
  /** Renamable handle, such as a GitHub login. */
  providerHandle: 5,
  provisional: 6,
} as const;

export type IdentityAnchorTier = (typeof IDENTITY_ANCHOR_TIER)[keyof typeof IDENTITY_ANCHOR_TIER];

export interface IdentityAnchorInput {
  readonly kind: IdentityKind;
  /** Set by an explicit user pin or correction. */
  readonly userPinned?: boolean;
  /** `entity_identities.verified`. Gates the tier-2 directory slot. */
  readonly verified?: boolean;
}

export function identityAnchorRank({
  kind,
  userPinned,
  verified,
}: IdentityAnchorInput): IdentityAnchorTier {
  if (userPinned) return IDENTITY_ANCHOR_TIER.userPinned;

  switch (kind) {
    case "google_directory_id":
      // An unverified directory id must not outrank email.
      return verified
        ? IDENTITY_ANCHOR_TIER.directoryVerified
        : IDENTITY_ANCHOR_TIER.providerAccountId;
    case "email":
      return IDENTITY_ANCHOR_TIER.email;
    case "github_user_id":
    case "slack_id":
    case "notion_user_id":
    case "domain":
    // Anchors for non-person nodes. Immutable, so not the handle tier.
    case "github_repository_id":
    case "integration_object_key":
      return IDENTITY_ANCHOR_TIER.providerAccountId;
    case "github_login":
    // `owner/repo` can be renamed or transferred.
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
 * Input to `computeStableEntityId` (D2). Seed only from the identity and `userId`,
 * never a name, kind, score, or random id.
 */
export const STABLE_ENTITY_ID_VERSION = 1 as const;

export interface StableEntityIdInput {
  readonly v: typeof STABLE_ENTITY_ID_VERSION;
  readonly userId: string;
  readonly identityKind: IdentityKind;
  /** Output of `canonicalizeIdentityValue`. */
  readonly normalizedValue: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Entity kinds + edge types (D5, D7)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Node kinds (D7). Kind lives in the versioned `entity_profiles`, so a reclassify keeps the id.
 * Only `person` gets person scoring. `unknown` also gets no edge promotion.
 */
export const ENTITY_NODE_KINDS = [
  "person",
  "organization",
  "group",
  "service",
  "repository",
  "project",
  // What a recurring notification is about, such as an alarm or a PR (ADR-0092).
  // One kind with no subtypes: a label list splits one referent across labels.
  "referent",
  "unknown",
] as const;

export const entityNodeKindSchema = z.enum(ENTITY_NODE_KINDS);

export type EntityNodeKind = (typeof ENTITY_NODE_KINDS)[number];

/** Never scored as a person (D7). */
export const NON_PERSON_ENTITY_KINDS = [
  "organization",
  "group",
  "service",
  "repository",
  "project",
  "referent",
  "unknown",
] as const satisfies readonly EntityNodeKind[];

export function isPersonScorable(kind: EntityNodeKind): boolean {
  return kind === "person";
}

/**
 * Middle segment of `provider:kind:externalId` to node kind. Both `project` and `referent`
 * anchor on `integration_object_key`, so only the segment tells them apart.
 * Minters and the classifier share this table. Not keyed by provider. List only segments a minter writes today.
 */
export const INTEGRATION_OBJECT_KIND_SEGMENTS = {
  // ADR-0092. `referent` is the fallback when no provider id was found.
  pull_request: "referent",
  issue: "referent",
  discussion: "referent",
  commit: "referent",
  check_suite: "referent",
  referent: "referent",
  // ADR-0062 provider objects.
  project: "project",
} as const satisfies Readonly<Record<string, EntityNodeKind>>;

export type IntegrationObjectKindSegment = keyof typeof INTEGRATION_OBJECT_KIND_SEGMENTS;

/** Segments that anchor node kind `K`. Minters take this, so an unlisted segment does not compile. */
export type IntegrationObjectSegmentFor<K extends EntityNodeKind> = {
  [Segment in IntegrationObjectKindSegment]: (typeof INTEGRATION_OBJECT_KIND_SEGMENTS)[Segment] extends K
    ? Segment
    : never;
}[IntegrationObjectKindSegment];

/** The one builder of the `provider:kind:externalId` shape. The caller owns `externalId` length and case. */
export function integrationObjectKey(
  provider: string,
  segment: IntegrationObjectKindSegment,
  externalId: string,
): string {
  return `${provider}:${segment}:${externalId}`;
}

/** The registered segment of an `integration_object_key`, or `null` if malformed or unlisted. */
export function integrationObjectKeySegment(value: string): IntegrationObjectKindSegment | null {
  const segments = value.split(":");
  const candidate = segments.length >= 3 ? segments[1] : undefined;

  if (!candidate) return null;

  return isIntegrationObjectKindSegment(candidate) ? candidate : null;
}

function isIntegrationObjectKindSegment(value: string): value is IntegrationObjectKindSegment {
  return Object.hasOwn(INTEGRATION_OBJECT_KIND_SEGMENTS, value);
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

/** Kind classifier output, stored in projection provenance. */
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

/**
 * Evidence codes for a `service` classification. The knowledge classifier and the triage
 * sender-kind floor each keep a total `satisfies Record<ServiceEvidenceCode, …>` table,
 * so a new code fails to compile until both decide on it. They decide differently on purpose.
 */
export const SERVICE_EVIDENCE_CODES = {
  /** `noreply@`, `notifications@`, `…-noreply@`. */
  localStrong: "email:local:service_strong",
  /** `…@noreply.github.com`. */
  domainStrong: "email:domain:service_strong",
  /** `billing@`, `support@`. A human may read it. */
  localRole: "email:local:service",
  /** An `Auto-Submitted` header. A human's out-of-office carries this too. */
  autoSubmitted: "gmail:auto_submitted",
} as const;

export type ServiceEvidenceCode =
  (typeof SERVICE_EVIDENCE_CODES)[keyof typeof SERVICE_EVIDENCE_CODES];

const SERVICE_EVIDENCE_CODE_VALUES = new Set<string>(Object.values(SERVICE_EVIDENCE_CODES));

export function isServiceEvidenceCode(value: string): value is ServiceEvidenceCode {
  return SERVICE_EVIDENCE_CODE_VALUES.has(value);
}

// Not `.catchall(jsonValueSchema)`: that checks the optional keys against the index
// signature, which would force `JsonValue` to admit `undefined`.
export const projectionProvenanceSchema = z.looseObject({
  observationIds: z.array(z.string()).optional(),
  familyKeys: z.array(z.string()).optional(),
  classification: entityKindClassificationSchema.optional(),
});

export type ProjectionProvenance = z.infer<typeof projectionProvenanceSchema>;

/** Traversable edge types. A co-occurrence pair becomes `frequent_collaborator` only past promotion (D5). */
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
// Significance fold knobs (D5, D6)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Above this many participants an event adds no co-occurrence (D5).
 * Below it, each pair gets `weight += sourceWeight / participantCount`.
 */
export const FAN_OUT_CUTOFF = 12;

/** Weight a pair needs to become a `frequent_collaborator` edge (D5). */
export const PROMOTION_THRESHOLD = 2.0;

/**
 * Promotion also needs this many observations across this many families, so one
 * noisy thread cannot mint an edge. Gmail also requires thread diversity.
 */
export const PROMOTION_MIN_OBSERVATIONS = 3;

export const PROMOTION_MIN_FAMILIES = 2;

/**
 * Weight per interaction class (D6). Keys are fold classes, not `OBSERVATION_KINDS`.
 * At a threshold of 2.0, a 1:1 reply promotes after about 5 touches.
 * List only classes a live reducer produces.
 */
export const SOURCE_WEIGHTS = {
  gmail_reply: 0.8,
  gmail_direct: 0.65,
  gmail_cc: 0.25,
  gmail_blast: 0.0,
} as const;

export type SourceWeightKey = keyof typeof SOURCE_WEIGHTS;

export function sourceWeight(key: SourceWeightKey): number {
  return SOURCE_WEIGHTS[key];
}

/**
 * Time-invariant score inputs only (D6/D13). The projection checksum covers them, so
 * nothing from the wall clock. Recency comes from `lastSeenAt` at read time.
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

/** The `projection_runs` name for the entity graph. A typo would strand runs under an unread name. */
export const USER_MODEL_PROJECTION_NAME = "user-model";

/** Stable BullMQ result reasons for a Gmail kind refold that does no work. */
export const GMAIL_KIND_REFOLD_SKIPPED_REASONS = [
  "no-active-projection",
  "no-gmail-observations",
  "up-to-date",
] as const;

export const gmailKindRefoldSkippedReasonSchema = z.enum(GMAIL_KIND_REFOLD_SKIPPED_REASONS);

export type GmailKindRefoldSkippedReason = z.infer<typeof gmailKindRefoldSkippedReasonSchema>;

export const PROJECTION_RUN_STATUS = ["running", "completed", "failed"] as const;

export const projectionRunStatusSchema = z.enum(PROJECTION_RUN_STATUS);

export type ProjectionRunStatus = (typeof PROJECTION_RUN_STATUS)[number];

export const projectionCursorValueSchema = z
  .object({
    lastObservationId: z.string().optional(),
    occurredAt: z.iso.datetime().optional(),
    sourceCursor: jsonValueSchema.optional(),
  })
  .strict();

export type ProjectionCursorValue = z.infer<typeof projectionCursorValueSchema>;

/** Replay cursor per source. Partial: a run records only the sources it touched. */
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

/** A fact is about the user or about an entity node. `FactTypeDef` adds `any`. */
export const FACT_SUBJECT_KINDS = ["user", "entity"] as const;

export const factSubjectKindSchema = z.enum(FACT_SUBJECT_KINDS);

export type FactSubjectKind = (typeof FACT_SUBJECT_KINDS)[number];

export interface FactTypeDef {
  readonly subject: FactSubjectKind | "any";
  readonly description: string;
}

/**
 * The one registry of durable fact types (D8). Transient content such as passcodes is not a fact.
 * Keys are concepts: `employer`, never `current_company`. `status` and validity windows carry currentness.
 * Gate `user_facts.key` writes with `isUserFactKey`, which also admits `standing_instruction`.
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

export const CANONICAL_FACT_KEYS =
  // SAFETY: `Object.keys` of the registry is exactly `keyof typeof FACT_ONTOLOGY`.
  Object.keys(FACT_ONTOLOGY) as readonly FactKey[];

/** `relationship:<email>` keys the user's relation to a person. */
export const RELATIONSHIP_FACT_PREFIX = "relationship:";

/** `pref:<name>` keys a durable preference. */
export const PREF_FACT_PREFIX = "pref:";

export const CANONICAL_FACT_PREFIXES = [RELATIONSHIP_FACT_PREFIX, PREF_FACT_PREFIX] as const;

/**
 * Spellings seen in producers, mapped to canonical keys before dedup.
 * Only observed spellings: an unlisted near-miss (`website`) stays `unknown_key`.
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

/** `wasAlias` is true when the key changed; `originalKey` keeps the input for provenance. */
export type CanonicalizeFactKeyResult =
  | { ok: true; key: string; wasAlias: false }
  | { ok: true; key: string; wasAlias: true; originalKey: string }
  | { ok: false; reason: "unknown_key" };

/**
 * Map a fact key onto the ontology before dedup. Aliases map; prefix suffixes are normalized.
 * A `relationship:` suffix must be an email. Key name only: trust decisions live in `fact-policy.ts`.
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
 * Every legal `user_facts.key`: the ontology plus `standing_instruction` (ADR-0058).
 * Gate column writes with this; classify fact types with `isFactKey`.
 */
export type UserFactKey = FactKey | typeof STANDING_INSTRUCTION_KEY;

export function isUserFactKey(key: string): key is UserFactKey {
  return isFactKey(key) || key === STANDING_INSTRUCTION_KEY;
}
