import {
  gmailEmailMessagePayloadSchema,
  type EntityKindClassification,
  type EntityNodeKind,
  type IdentityRef,
} from "@alfred/contracts";
import type { Observation } from "@alfred/db/schemas";

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
    return classification("project", PERSON_CONFIDENCE, ["identity:integration_object_key"]);
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
  return typeof value === "string" && value.trim().length > 0;
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
