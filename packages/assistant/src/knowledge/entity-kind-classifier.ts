import {
  canonicalizeIdentityValue,
  classifyEmailDomain,
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  integrationObjectKeySegment,
  INTEGRATION_OBJECT_KIND_SEGMENTS,
  type EntityKindClassification,
  type EntityNodeKind,
  type IdentityRef,
} from "@alfred/contracts";
import type { Observation } from "@alfred/db/schemas";
import type { EntityKind } from "./entity-graph";

const AUTHORITATIVE_CONFIDENCE = 0.99;

const STRONG_CONFIDENCE = 0.92;

const PERSON_CONFIDENCE = 0.82;

const WEAK_CONFIDENCE = 0.58;

const BULK_PRECEDENCE_VALUES = new Set(["bulk", "list"]);

const STRONG_SERVICE_LOCALS = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "notifications",
  "notification",
  "alerts",
  "alert",
  "mailer-daemon",
  "postmaster",
  "bounces",
  "bounce",
]);

const SERVICE_LOCALS = new Set([
  "billing",
  "security",
  "account",
  "accounts",
  "updates",
  "newsletter",
  "news",
  "marketing",
  "support",
  "help",
  "admin",
  "calendar-notification",
]);

const GROUP_LOCALS = new Set([
  "all",
  "everyone",
  "team",
  "engineering",
  "eng",
  "dev",
  "developers",
  "product",
  "design",
  "sales",
  "ops",
  "people",
  "hr",
  "finance",
]);

const SERVICE_DOMAIN_SUFFIXES = [
  "github.com",
  "linear.app",
  "clickup.com",
  "slack.com",
  "stripe.com",
  "stripe.email",
  "sentry.io",
  "vercel.com",
  "vercel.app",
  "railway.app",
  "notion.so",
  "atlassian.net",
  "google.com",
  "googlemail.com",
  "amazonaws.com",
  "amazonses.com",
] as const;

const SERVICE_LOCAL_PREFIX_RE =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|billing[-_.]|security[-_.]|account[-_.]|calendar[-_.]|bounce[-_.])/i;

const GROUP_LOCAL_RE =
  /(^|[-_.+])(all|team|engineering|eng|developers?|dev|product|design|sales|ops|people|hr|finance)([-_.+]|$)/i;

const FIRST_LAST_LOCAL_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/i;

const PERSON_DISPLAY_RE = /^[\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+)+$/u;

const NON_PERSON_DISPLAY_RE =
  /\b(team|engineering|notifications?|alerts?|billing|support|newsletter|security|updates|digest|no[-\s]?reply|noreply|service|admin|marketing|sales|careers?|jobs)\b/i;

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
}

export function classifyEntityKind(input: ClassifyEntityKindInput): EntityKindClassification {
  const signals = [
    ...(input.payloadSignals ?? []),
    ...signalsFromObservations(input.observations ?? []),
  ];

  const evidenceCodes: string[] = [];

  const listEvidence = listEvidenceCodes(signals);

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
    // TWO node kinds anchor on this identity kind — an ADR-0062 provider object
    // (`project`) and an ADR-0092 `referent` — so the kind alone decides
    // nothing, and reading it as `project` labelled every referent a project.
    // The registered kind SEGMENT of the value decides, from the one table both
    // this classifier and every minter share.
    const segment = integrationObjectKeySegment(identity.value);

    if (segment) {
      return classification(INTEGRATION_OBJECT_KIND_SEGMENTS[segment], STRONG_CONFIDENCE, [
        `identity:integration_object_key:${segment}`,
      ]);
    }

    // An unregistered segment is a minter that skipped the table. Say `unknown`
    // and keep `project` as the guess: `kind` is versioned, so a replay fixes it
    // once the segment is registered, and a wrong hard claim never lands.
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

  const parsed = parseEmail(identity.value);

  if (!parsed) {
    return classification("unknown", WEAK_CONFIDENCE, ["email:unparseable"]);
  }

  if (isStrongServiceLocal(parsed.localPart)) {
    return classification("service", STRONG_CONFIDENCE, ["email:local:service_strong"]);
  }

  if (signals.some((signal) => hasAutoSubmittedServiceSignal(signal.autoSubmitted))) {
    return classification("service", STRONG_CONFIDENCE, ["gmail:auto_submitted"]);
  }

  const displayNames = normalizedDisplayNames(input.displayNames ?? [], input.observations ?? []);
  const personDisplay = displayNames.find(isLikelyPersonDisplayName);

  if (personDisplay && !isServiceLocal(parsed.localPart)) {
    return classification("person", PERSON_CONFIDENCE, ["display:person_like"]);
  }

  if (isGroupLocal(parsed.localPart)) {
    return classification("unknown", WEAK_CONFIDENCE, ["email:local:group_weak"], "group");
  }

  if (displayNames.some(isLikelyGroupDisplayName)) {
    return classification("unknown", WEAK_CONFIDENCE, ["display:group_weak"], "group");
  }

  if (FIRST_LAST_LOCAL_RE.test(parsed.localPart) && !isServiceLocal(parsed.localPart)) {
    return classification("person", PERSON_CONFIDENCE, ["email:local:person_like"]);
  }

  if (isServiceLocal(parsed.localPart)) {
    return classification("service", STRONG_CONFIDENCE, ["email:local:service"]);
  }

  if (isServiceDomain(parsed.domain)) {
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

function listEvidenceCodes(signals: readonly GmailPayloadSignals[]): string[] {
  const evidenceCodes = new Set<string>();

  for (const signal of signals) {
    if (isNonEmpty(signal.listId)) evidenceCodes.add("gmail:list_id");

    if (isNonEmpty(signal.listUnsubscribe)) evidenceCodes.add("gmail:list_unsubscribe");
    const precedence = signal.precedence?.trim().toLowerCase();

    if (precedence && BULK_PRECEDENCE_VALUES.has(precedence)) {
      evidenceCodes.add(`gmail:precedence:${precedence}`);
    }
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

function parseEmail(value: string): { localPart: string; domain: string } | null {
  const at = value.lastIndexOf("@");

  if (at < 1 || at === value.length - 1) return null;

  return {
    localPart: value.slice(0, at).toLowerCase(),
    domain: value.slice(at + 1).toLowerCase(),
  };
}

function isStrongServiceLocal(localPart: string): boolean {
  return STRONG_SERVICE_LOCALS.has(localPart) || SERVICE_LOCAL_PREFIX_RE.test(localPart);
}

function isServiceLocal(localPart: string): boolean {
  return isStrongServiceLocal(localPart) || SERVICE_LOCALS.has(localPart);
}

function isGroupLocal(localPart: string): boolean {
  return GROUP_LOCALS.has(localPart) || GROUP_LOCAL_RE.test(localPart);
}

function isServiceDomain(domain: string): boolean {
  return SERVICE_DOMAIN_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
  );
}

function hasAutoSubmittedServiceSignal(value: string | null | undefined): boolean {
  if (!value) return false;

  return value.trim().toLowerCase() !== "no";
}

function isLikelyPersonDisplayName(displayName: string): boolean {
  if (NON_PERSON_DISPLAY_RE.test(displayName)) return false;

  return PERSON_DISPLAY_RE.test(displayName);
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

/**
 * ── the legacy `entities.kind` bar (#1108) ──────────────────────────────────
 *
 * The ADR-0067 substrate above answers `EntityNodeKind` (8 members) for
 * `entity_profiles.kind`. The legacy memory-module graph (`entities.kind`,
 * ADR-0012) has its own 6-member `EntityKind` vocabulary and, until this bar,
 * no classification at all: the team-graph writer wrote the literal `"person"`
 * for every mail contact, so a GitHub advisory id, a CI workflow name and a
 * retailer all became people. The two graphs keep their own vocabularies, but
 * person-ness now has ONE definition — this file — for both.
 */

/**
 * Total map from the ADR-0067 node kind onto the legacy `entities.kind`. Five
 * node kinds have no legacy member, so they land on `other` — the ADR's own
 * answer (alternative (d): non-humans are typed nodes, never suppressed).
 *
 * `satisfies` rather than an annotation: an annotation on a const table trips
 * oxlint `no-known-value-widening`, and a `switch` with a `default` would hide
 * a new node kind. This way a new `EntityNodeKind` member fails to compile
 * until it is named here.
 */
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

function entityKindForNodeKind(kind: EntityNodeKind): EntityKind {
  return NODE_KIND_TO_ENTITY_KIND[kind];
}

/**
 * True when `value` is a hostname that is the contact's own domain, or a
 * parent or child of it. The ONE rule the VALUE side of the kind bar holds,
 * and a DENY test: a single-token name ("Sanyam"), a role suffix ("Jane Doe |
 * Marketing"), a pronoun parenthesis ("Jane Doe (she/her)") and a dotted local
 * part used as a display name ("sarah.chen") all pass it.
 *
 * It states the cross-kind duplicate rule exactly. `collectOrgDomains` mints
 * ONE `organization` row per non-free-mail sender domain, so a contact whose
 * display value IS its own mail domain is that organization restated
 * (`Amazon.in` from `order-update@amazon.in`). It asks `classifyEmailDomain`
 * with a bare `{ domain }` first, so "is this string a hostname at all" reuses
 * the ONE DNS grammar in `@alfred/contracts` (`hostname.ts`) rather than a
 * fourth hand-rolled regex.
 *
 * A second value rule rejected a name holding `/`, for
 * `99Yash/GHSA-xwg4-73v4-xw9w`. It is deleted (#1108 round 3). It matched the
 * character anywhere in the string, so it demoted `Jane Doe (she/her)` and
 * `Anna Müller / ACME GmbH`, and it bought nothing: every row it was written
 * for arrives on `noreply@` or `notifications@`, which {@link
 * isHardNonPersonClaim} already demotes from the address alone.
 *
 * The VALUE side deliberately does NOT reuse `NON_PERSON_DISPLAY_RE` either.
 * That regex is an AND-partner of the positive `PERSON_DISPLAY_RE`; standalone
 * it rejects the surnames Jobs, Sales and Service and every "Name | Function"
 * display convention, and a wrong demotion is not cosmetic —
 * `gmail-recipient-policy` filters `kind = 'person'` and fails a live send
 * closed. The ADDRESS side still reaches that regex through
 * `isLikelyPersonDisplayName`, but only to WITHHOLD the person fast path,
 * never to demote on its own: {@link isHardNonPersonClaim} decides that.
 */
function restatesOwnDomain(value: string, domain: string): boolean {
  const candidate = value.trim().toLowerCase();

  if (!candidate || !domain) return false;

  if (classifyEmailDomain({ domain: candidate }) === null) return false;

  return (
    candidate === domain || domain.endsWith(`.${candidate}`) || candidate.endsWith(`.${domain}`)
  );
}

export interface ClassifyContactKindInput {
  /** The contact's primary email address. Canonicalized here, so any case is fine. */
  readonly address: string;
  /**
   * The value that is — or is about to be — stored in `entities.canonical_name`.
   *
   * NOT the display name this run's headers carried. `canonical_name` is
   * written once at insert and never updated, so it is the only display
   * evidence every reader shares: the live writer, the purge script and a dry
   * run all classify the same string and cannot disagree. A per-run display
   * name made the kind flap — one message with a bare `<address>` re-minted
   * `person` on a row the bar had just demoted (#1108 round 1).
   */
  readonly canonicalName: string;
}

/**
 * True when a non-person answer is a HARD claim — the only kind of claim that
 * may take `person` away from a mail contact.
 *
 * On this graph `kind = 'person'` is a CAPABILITY, not a label.
 * `gmail-recipient-policy` lets a `gmail.send_draft` reach only an address that
 * a `person` row already holds, and six more readers score a contact by the
 * same column. So a wrong demotion refuses a live send to somebody the user
 * has already emailed, while a missed demotion leaves one noisy row. The two
 * costs are not symmetric, and the bar sits where the cheaper mistake is.
 *
 * {@link classifyEntityKind} answers for `entity_profiles.kind`, where
 * `service` is a harmless label. Two of its email branches reach a non-person
 * answer on soft evidence, and neither may demote here:
 *   - every `unknown` answer — a group-word local part (`hr.priya@`), a
 *     `SERVICE_DOMAIN_SUFFIXES` domain (`jane@notion.so`), an unparseable
 *     address. It carries `WEAK_CONFIDENCE` and names its own guess in
 *     `bestGuess`, so it is a guess by construction.
 *   - `service` from a SOFT service local (`billing@`, `support@`, `admin@`).
 *     The person fast path cannot overrule it, because that path is gated on
 *     `!isServiceLocal(localPart)`, so even an unambiguous human display name
 *     on a role mailbox still answers `service`.
 *
 * Only a STRONG service local (`noreply@`, `notifications@`, `alerts@`,
 * `bounces@`) or a bulk-list header is a shape no human mailbox carries, and
 * those are exactly the rows #1108 measured on prod.
 */
function isHardNonPersonClaim(classified: EntityKindClassification, localPart: string): boolean {
  if (classified.kind === "person") return false;

  if (classified.confidence < STRONG_CONFIDENCE) return false;

  return classified.kind !== "service" || isStrongServiceLocal(localPart);
}

/**
 * The legacy `entities.kind` for ONE mail contact.
 *
 * Two independent bars, because neither one alone clears the prod queue:
 *   - the ADDRESS side delegates to {@link classifyEntityKind} and then to
 *     {@link isHardNonPersonClaim}, so a `noreply@`/`notifications@` envelope
 *     is never a person and a soft guess never demotes one;
 *   - the VALUE side runs {@link restatesOwnDomain} over the stored canonical
 *     name.
 *
 * A canonical name equal to the address carries no display evidence — the
 * writer stores `displayName ?? address` — so the value side is skipped there
 * and the address side decides alone.
 *
 * An address that is not a well-formed email is not a person either — the
 * identity parse is the owning boundary, and a failure answers `other` rather
 * than throwing, so one malformed header never fails a capture run.
 */
export function classifyContactKind(input: ClassifyContactKindInput): EntityKind {
  const address = canonicalizeIdentityValue("email", input.address);

  const identity = identityRefSchema.safeParse({ kind: "email", value: address });
  const parsed = parseEmail(address);

  if (!identity.success || !parsed) return "other";

  const stored = input.canonicalName.trim();

  const displayName = normalizeDisplayName(
    stored.toLowerCase() === address.toLowerCase() ? undefined : stored,
  );

  const classified = classifyEntityKind({
    identity: identity.data,
    displayNames: displayName ? [displayName] : [],
  });

  if (isHardNonPersonClaim(classified, parsed.localPart)) {
    return entityKindForNodeKind(classified.kind);
  }

  // Every other answer keeps `person`, so the value bar still runs over it: a
  // contact rescued from a soft service claim can still be its own domain
  // restated (`Amazon.in` from `order-update@amazon.in`).
  if (!displayName) return "person";

  return restatesOwnDomain(displayName, parsed.domain) ? "other" : "person";
}
