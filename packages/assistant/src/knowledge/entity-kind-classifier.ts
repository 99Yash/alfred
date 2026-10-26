import {
  canonicalizeIdentityValue,
  classifyBareDomain,
  classifyDomainFirstLabel,
  classifyLocalPart,
  emailDomain,
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  isDomainOrSubdomain,
  isFirstLastLocalPart,
  isGroupLocal,
  isLikelyPersonDisplayName,
  isServicePlatformDomain,
  integrationObjectKeySegment,
  INTEGRATION_OBJECT_KIND_SEGMENTS,
  isServiceEvidenceCode,
  SERVICE_EVIDENCE_CODES,
  splitEmail,
  type EntityKindClassification,
  type EntityNodeKind,
  type IdentityRef,
  type DomainFirstLabelClass,
  type ListEvidenceCode,
  type LocalPartMatch,
  type MatchedSenderClass,
  type ServiceEvidenceCode,
} from "@alfred/contracts";
import type { Observation } from "@alfred/db/schemas";
import type { ContactKind, EntityKind } from "./entity-graph";

const AUTHORITATIVE_CONFIDENCE = 0.99;

const STRONG_CONFIDENCE = 0.92;

const PERSON_CONFIDENCE = 0.82;

const WEAK_CONFIDENCE = 0.58;

/** Exact `Precedence:` values, lowercased and trimmed. */
const BULK_PRECEDENCE_CODES: ReadonlyMap<string, ListEvidenceCode> = new Map([
  ["bulk", "gmail:precedence:bulk"],
  ["list", "gmail:precedence:list"],
]);

type LocalServiceEvidence = "localStrong" | "localRole";

/**
 * The service evidence a local part writes. A role word alone writes the weak
 * `localRole`; a role prefix (`billing-x`) writes `localStrong`, as before.
 * A token match never writes evidence: `jane.alerts.fan` is not a machine.
 */
const LOCAL_SERVICE_EVIDENCE = {
  automated: { whole: "localStrong", edge: "localStrong", token: null },
  role: { whole: "localRole", edge: "localStrong", token: null },
  group: { whole: null, edge: null, token: null },
} satisfies Record<MatchedSenderClass, Record<LocalPartMatch, LocalServiceEvidence | null>>;

function localServiceEvidence(localPart: string): LocalServiceEvidence | null {
  const classified = classifyLocalPart(localPart);

  return classified.senderClass === "none"
    ? null
    : LOCAL_SERVICE_EVIDENCE[classified.senderClass][classified.match];
}

const LIST_DISPLAY_RE =
  /\b(team|engineering|developers?|all hands|newsletter|digest|mailing list|distribution list)\b/i;

export interface GmailPayloadSignals {
  readonly listId?: string | null;
  readonly listUnsubscribe?: string | null;
  readonly precedence?: string | null;
  readonly autoSubmitted?: string | null;
}

export interface ClassifyEntityKindInput {
  readonly identity: IdentityRef;
  readonly displayNames?: readonly string[];
  readonly observations?: readonly Observation[];
  readonly payloadSignals?: readonly GmailPayloadSignals[];
  /** Stored list-header codes. They reach the same branch as `payloadSignals`. */
  readonly listEvidence?: readonly ListEvidenceCode[];
}

export function classifyEntityKind(input: ClassifyEntityKindInput): EntityKindClassification {
  const signals = [
    ...(input.payloadSignals ?? []),
    ...signalsFromObservations(input.observations ?? []),
  ];

  const evidenceCodes: string[] = [];

  const listEvidence = [
    ...new Set([...listEvidenceCodes(signals), ...(input.listEvidence ?? [])]),
  ].sort();

  if (listEvidence.length > 0) {
    return classification("group", AUTHORITATIVE_CONFIDENCE, listEvidence);
  }

  const identity = input.identity;

  if (identity.kind === "domain") {
    return classification("organization", STRONG_CONFIDENCE, ["identity:domain"]);
  }

  if (identity.kind === "github_repository_id" || identity.kind === "github_repository_full_name") {
    return classification("repository", STRONG_CONFIDENCE, [`identity:${identity.kind}`]);
  }

  if (identity.kind === "integration_object_key") {
    // Two node kinds use this identity kind (`project` and `referent`), so the registered segment decides.
    const segment = integrationObjectKeySegment(identity.value);

    if (segment) {
      return classification(INTEGRATION_OBJECT_KIND_SEGMENTS[segment], STRONG_CONFIDENCE, [
        `identity:integration_object_key:${segment}`,
      ]);
    }

    // An unregistered segment means a minter skipped the table. `kind` is versioned, so a replay fixes it.
    return classification(
      "unknown",
      WEAK_CONFIDENCE,
      ["identity:integration_object_key:unregistered"],
      "project",
    );
  }

  if (identity.kind !== "email") {
    return classification("unknown", WEAK_CONFIDENCE, [`identity:${identity.kind}`]);
  }

  const parsed = splitEmail(identity.value);

  if (!parsed) {
    return classification("unknown", WEAK_CONFIDENCE, ["email:unparseable"]);
  }

  const localEvidence = localServiceEvidence(parsed.localPart);

  if (localEvidence === "localStrong") {
    return classification("service", STRONG_CONFIDENCE, [SERVICE_EVIDENCE_CODES.localStrong]);
  }

  // Before the `display:person_like` fast path: these rows carry person-like display names.
  if (isStrongServiceDomain(parsed.domain)) {
    return classification("service", STRONG_CONFIDENCE, [SERVICE_EVIDENCE_CODES.domainStrong]);
  }

  if (signals.some((signal) => hasAutoSubmittedServiceSignal(signal.autoSubmitted))) {
    return classification("service", STRONG_CONFIDENCE, [SERVICE_EVIDENCE_CODES.autoSubmitted]);
  }

  const displayNames = normalizedDisplayNames(input.displayNames ?? [], input.observations ?? []);
  const personDisplay = displayNames.find(isLikelyPersonDisplayName);

  if (personDisplay && !localEvidence) {
    return classification("person", PERSON_CONFIDENCE, ["display:person_like"]);
  }

  if (isGroupLocal(parsed.localPart)) {
    return classification("unknown", WEAK_CONFIDENCE, ["email:local:group_weak"], "group");
  }

  if (displayNames.some(isLikelyGroupDisplayName)) {
    return classification("unknown", WEAK_CONFIDENCE, ["display:group_weak"], "group");
  }

  if (isFirstLastLocalPart(parsed.localPart) && !localEvidence) {
    return classification("person", PERSON_CONFIDENCE, ["email:local:person_like"]);
  }

  if (localEvidence === "localRole") {
    return classification("service", STRONG_CONFIDENCE, [SERVICE_EVIDENCE_CODES.localRole]);
  }

  if (isServicePlatformDomain(parsed.domain)) {
    return classification("unknown", WEAK_CONFIDENCE, ["email:domain:service_weak"], "service");
  }

  evidenceCodes.push("email:mailbox:individual");

  return classification("person", PERSON_CONFIDENCE, evidenceCodes);
}

function signalsFromObservations(observations: readonly Observation[]): GmailPayloadSignals[] {
  const signals: GmailPayloadSignals[] = [];

  for (const observation of observations) {
    if (observation.kind !== "email_message") continue;
    const payload = gmailEmailMessagePayloadSchema.safeParse(observation.payload);

    if (!payload.success) continue;
    signals.push({
      listId: payload.data.headers.listId,
      listUnsubscribe: payload.data.headers.listUnsubscribe,
      precedence: payload.data.headers.precedence,
      autoSubmitted: payload.data.headers.autoSubmitted,
    });
  }

  return signals;
}

/** Sorted, deduped list codes. The team-graph writer persists these. */
export function listEvidenceCodes(signals: readonly GmailPayloadSignals[]): ListEvidenceCode[] {
  const evidenceCodes = new Set<ListEvidenceCode>();

  for (const signal of signals) {
    if (isNonEmpty(signal.listId)) evidenceCodes.add("gmail:list_id");

    if (isNonEmpty(signal.listUnsubscribe)) evidenceCodes.add("gmail:list_unsubscribe");
    const precedence = signal.precedence?.trim().toLowerCase();
    const precedenceCode = precedence ? BULK_PRECEDENCE_CODES.get(precedence) : undefined;

    if (precedenceCode) evidenceCodes.add(precedenceCode);
  }

  return [...evidenceCodes].sort();
}

function normalizedDisplayNames(
  directDisplayNames: readonly string[],
  observations: readonly Observation[],
): string[] {
  const names = new Set<string>();

  for (const name of directDisplayNames) {
    const normalized = normalizeDisplayName(name);

    if (normalized) names.add(normalized);
  }

  for (const observation of observations) {
    for (const participant of observation.participants.items) {
      const normalized = normalizeDisplayName(participant.displayName);

      if (normalized) names.add(normalized);
    }
  }

  return [...names];
}

function normalizeDisplayName(value: string | undefined): string | null {
  const trimmed = value
    ?.replace(/^"+|"+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return trimmed ? trimmed : null;
}

/**
 * True when the leftmost label is an automated word and is a subdomain
 * (`noreply.github.com`), not the apex (`noreply.com` can be a person's).
 * An infrastructure label (`mail.`, `bounce.`) says nothing: `jane@mail.company.com` is a person.
 * With no public-suffix list, `newsletter.co.uk` still matches; that demotion is reversible.
 */
function isStrongServiceDomain(domain: string): boolean {
  if (domain.split(".").length < 3) return false;

  return DOMAIN_LABEL_IS_STRONG[classifyDomainFirstLabel(domain)];
}

const DOMAIN_LABEL_IS_STRONG = {
  automated: true,
  infrastructure: false,
  none: false,
} satisfies Record<DomainFirstLabelClass, boolean>;

function hasAutoSubmittedServiceSignal(value: string | null | undefined): boolean {
  if (!value) return false;

  return value.trim().toLowerCase() !== "no";
}

function isLikelyGroupDisplayName(displayName: string): boolean {
  return LIST_DISPLAY_RE.test(displayName);
}

function isNonEmpty(value: string | null | undefined): boolean {
  return value != null && value.trim().length > 0;
}

function classification(
  kind: EntityNodeKind,
  confidence: number,
  evidenceCodes: readonly string[],
  bestGuess?: Exclude<EntityNodeKind, "unknown">,
): EntityKindClassification {
  return {
    kind,
    confidence,
    ...(bestGuess ? { bestGuess } : {}),
    evidenceCodes: [...evidenceCodes],
    researchStatus: "not_needed",
  };
}

// ── the legacy `entities.kind` bar (#1108) ──────────────────────────────────
// `entity_profiles.kind` and the legacy `entities.kind` keep their own
// vocabularies, but this file is the one definition of person-ness for both.

/** A new `EntityNodeKind` fails to compile until it is mapped here. Non-humans land on `other`. */
const NODE_KIND_TO_ENTITY_KIND = {
  person: "person",
  organization: "organization",
  group: "other",
  service: "other",
  repository: "other",
  project: "project",
  referent: "other",
  unknown: "other",
} satisfies Record<EntityNodeKind, EntityKind>;

type NodeKindEntityKind = (typeof NODE_KIND_TO_ENTITY_KIND)[EntityNodeKind];

function entityKindForNodeKind(kind: EntityNodeKind): NodeKindEntityKind {
  return NODE_KIND_TO_ENTITY_KIND[kind];
}

/**
 * True when `value` is the contact's own domain, or a parent or child of it
 * (`Amazon.in` from `order-update@amazon.in`). That duplicates the organization row.
 * Deny-only: names like `Jane Doe (she/her)` or `sarah.chen` pass. It avoids
 * `isLikelyPersonDisplayName`, which rejects real surnames like Jobs and Sales.
 */
function restatesOwnDomain(value: string, domain: string): boolean {
  const candidate = value.trim().toLowerCase();

  if (!candidate || !domain) return false;

  if (classifyBareDomain({ domain: candidate }) === null) return false;

  return isDomainOrSubdomain(domain, candidate) || isDomainOrSubdomain(candidate, domain);
}

export interface ClassifyContactKindInput {
  /** Canonicalized here, so any case is fine. */
  readonly address: string;
  /**
   * The stored `entities.canonical_name`, not this run's display name. It is
   * written once, so every reader classifies the same string and the kind cannot flap.
   */
  readonly canonicalName: string;
  /** The stored `metadata.listEvidence` (#1198), not this run's headers. Same reason as {@link canonicalName}. */
  readonly listEvidence: readonly ListEvidenceCode[];
  /** The user has sent mail to this address. It withholds list-header evidence only. */
  readonly userHasWrittenTo: boolean;
}

/**
 * True when a non-person answer is strong enough to take `person` away.
 * Here `kind = 'person'` is a capability: `gmail-recipient-policy` sends only to
 * person rows. A wrong demotion blocks a real send, so only hard claims demote:
 * a strong service local, a strong service domain label, or stored list
 * evidence the user has not written past. Soft `unknown` or `service` answers do not.
 */
function isHardNonPersonClaim(classified: EntityKindClassification): boolean {
  if (classified.kind === "person") return false;

  if (classified.confidence < STRONG_CONFIDENCE) return false;

  if (classified.kind !== "service") return true;

  return classified.evidenceCodes.some(
    (code) => isServiceEvidenceCode(code) && HARD_SERVICE_EVIDENCE[code],
  );
}

/** Total over {@link ServiceEvidenceCode}, like the triage sender-kind floor's table, so a new code cannot reach one and miss the other. */
const HARD_SERVICE_EVIDENCE = {
  "email:local:service_strong": true,
  "email:domain:service_strong": true,
  // A role mailbox may be staffed, and an out-of-office reply is a human.
  "email:local:service": false,
  "gmail:auto_submitted": false,
} satisfies Record<ServiceEvidenceCode, boolean>;

/**
 * The legacy `entities.kind` for one mail contact. Two bars: the address side
 * ({@link classifyEntityKind}, then {@link isHardNonPersonClaim}) and the value side
 * ({@link restatesOwnDomain}). When the canonical name is the address, only the address side runs.
 * A malformed address answers `other` instead of throwing, so one bad header cannot fail a run.
 */
export function classifyContactKind(input: ClassifyContactKindInput): ContactKind {
  const address = canonicalizeIdentityValue("email", input.address);

  const identity = identityRefSchema.safeParse({ kind: "email", value: address });
  const domain = emailDomain(address);

  if (!identity.success || !domain) return "other";

  const stored = input.canonicalName.trim();

  const displayName = normalizeDisplayName(
    stored.toLowerCase() === address.toLowerCase() ? undefined : stored,
  );

  const classified = classifyEntityKind({
    identity: identity.data,
    displayNames: displayName ? [displayName] : [],
    listEvidence: input.userHasWrittenTo ? [] : input.listEvidence,
  });

  if (isHardNonPersonClaim(classified)) {
    const mapped = entityKindForNodeKind(classified.kind);

    // The writer matches only `person`/`other`. A wider `CONTACT_KINDS` compiles silently, so teach this branch too.
    if (mapped === "organization" || mapped === "project") return "other";

    return mapped;
  }

  // A contact rescued from a soft service claim can still restate its own domain.
  if (!displayName) return "person";

  return restatesOwnDomain(displayName, domain) ? "other" : "person";
}
