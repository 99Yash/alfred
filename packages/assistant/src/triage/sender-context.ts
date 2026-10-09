/**
 * Deterministic sender parse (ADR-0042 #1), so the classifier gets a typed
 * `SenderContext`. Grow the bot list and body parsers only from observed traces.
 * Anything unclear is `effectiveAuthor: 'unknown'`.
 */

import {
  hasServiceWordSuffix,
  type BotSlug,
  type EffectiveAuthor,
  type SenderContext,
  type SenderKind,
} from "@alfred/contracts";
import { isExactGroupLocal } from "../knowledge";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ExtractSenderContextArgs {
  /** Raw header, e.g. `'CodeRabbit <noreply@github.com>'`. */
  fromHeader: string | null;
  subject: string | null;
  body: string;
}

export interface SenderContextResult {
  context: SenderContext;
  parserHit: "github" | "calendar" | "linear" | null;
  senderAddress: string | null;
  senderDomain: string | null;
}

export function extractSenderContext(args: ExtractSenderContextArgs): SenderContextResult {
  const parsed = parseFromHeader(args.fromHeader);
  const senderAddress = parsed?.address ?? null;
  const senderDomain = parsed?.domain ?? null;
  const fromKind = classifyFromKind(parsed);

  // A GitHub `[bot]` display name beats the body: a bot's bold headline
  // ("**Hold this merge.**") otherwise parses as a person. Structural, not a slug list.
  const displayNameBot = parsed ? githubDisplayNameBot(parsed) : undefined;

  const dispatch: BodyActorDispatch = displayNameBot
    ? { actor: displayNameBot, parserHit: "github" }
    : parsed
      ? parseBodyActor(parsed.domain, parsed.localPart, args.body)
      : { actor: undefined, parserHit: null };

  const bodyActor = dispatch.actor;
  const parserHit = dispatch.parserHit;

  const botSlug = resolveBotSlug({
    domain: parsed?.domain ?? null,
    localPart: parsed?.localPart ?? null,
    bodyActor,
  });

  const effectiveAuthor = deriveEffectiveAuthor({ fromKind, bodyActor, botSlug });

  const context: SenderContext = {
    fromKind,
    effectiveAuthor,
    ...(bodyActor ? { bodyActor } : {}),
    ...(botSlug ? { botSlug } : {}),
  };

  return { context, parserHit, senderAddress, senderDomain };
}

// ---------------------------------------------------------------------------
// From-header parsing
// ---------------------------------------------------------------------------

interface ParsedFrom {
  displayName: string | null;
  address: string;
  localPart: string;
  domain: string;
}

const ANGLE_ADDR_RE = /^(.*?)<([^>]+)>\s*$/;

function parseFromHeader(raw: string | null): ParsedFrom | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  if (!trimmed) return null;

  let displayName: string | null = null;
  let addressRaw: string;
  const angle = trimmed.match(ANGLE_ADDR_RE);

  if (angle && angle[2] !== undefined) {
    const namePart = (angle[1] ?? "")
      .trim()
      .replace(/^"+|"+$/g, "")
      .trim();

    displayName = namePart || null;
    addressRaw = angle[2].trim();
  } else {
    addressRaw = trimmed;
  }

  const at = addressRaw.lastIndexOf("@");

  if (at < 1 || at === addressRaw.length - 1) return null;
  const localPart = addressRaw.slice(0, at).toLowerCase();
  const domain = addressRaw.slice(at + 1).toLowerCase();

  if (!localPart || !domain || domain.indexOf(".") === -1) return null;

  return { displayName, address: `${localPart}@${domain}`, localPart, domain };
}

// ---------------------------------------------------------------------------
// Recipient (`To:`/`Cc:`) address extraction
// ---------------------------------------------------------------------------

// A global scan, not a comma split: `"Doe, Jane" <j@x>` breaks a split.
const RECIPIENT_ADDRESS_RE = /[^\s<>,";()]+@[^\s<>,";()]+/g;

/** Every address in a To/Cc header, canonicalized. Lives here to stay DB-free. */
export function recipientAddresses(header: string | null | undefined): string[] {
  const out: string[] = [];

  for (const m of String(header ?? "").matchAll(RECIPIENT_ADDRESS_RE)) {
    const addr = canonicalizeEmailForMatch(m[0]);

    if (addr) out.push(addr);
  }

  return out;
}

/** Lowercase, trim, drop a `+tag` (`u+alerts@x.com` → `u@x.com`). `""` when not an address. */
export function canonicalizeEmailForMatch(raw: string | null | undefined): string {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();

  const at = value.lastIndexOf("@");

  if (at < 1 || at === value.length - 1) return "";
  const localFull = value.slice(0, at);
  const plus = localFull.indexOf("+");
  const local = plus > 0 ? localFull.slice(0, plus) : localFull;

  if (!local) return "";

  return `${local}@${value.slice(at + 1)}`;
}

// ---------------------------------------------------------------------------
// fromKind classification
// ---------------------------------------------------------------------------

/** Always a service envelope. `info`/`support` go in the weak set: small companies staff them. */
const STRONG_SERVICE_LOCAL = new Set<string>([
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

/** Maybe a service, maybe staffed. */
const WEAK_SERVICE_LOCAL = new Set<string>([
  "info",
  // Not `team`: it lives in GROUP_LOCALS (#1187).
  "hello",
  "support",
  "billing",
  "security",
  "updates",
  "news",
  "newsletter",
  "events",
  "event",
  "marketing",
  "account",
  "accounts",
  "contact",
  "admin",
]);

/** Always a service envelope. Add only from observed mail. */
const KNOWN_SERVICE_DOMAINS = new Set<string>([
  "github.com",
  "noreply.github.com",
  "linear.app",
  "sentry.io",
  "stripe.com",
  "stripe.email",
  "google.com",
  "accounts.google.com",
  "vercel.com",
  "vercel-app.com",
  "datadog.com",
  "datadoghq.com",
  "slack.com",
  "atlassian.net",
  "notion.so",
  "amazonses.com",
  // The human is in the display name ("Vaibhav (via LinkedIn)"); the envelope is the platform's.
  "linkedin.com",
]);

const SERVICE_LOCAL_PREFIX_RE =
  /^(no[-_.]?reply|donotreply|do[-_]not[-_]reply|notification|notifications|alerts?|security[-_]|billing[-_]|account[-_]|calendar[-_])/;

/** Never rescued as a person, even behind a person-like display name. */
function isAutomatedEnvelopeLocal(localPart: string): boolean {
  return (
    STRONG_SERVICE_LOCAL.has(localPart) ||
    SERVICE_LOCAL_PREFIX_RE.test(localPart) ||
    hasServiceWordSuffix(localPart)
  );
}

const FIRST_LAST_LOCAL_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/i;

const ORG_DISPLAY_TOKEN_RE =
  /\b(inc|incorporated|ltd|limited|llc|llp|gmbh|plc|corp|corporation|company|co|team|notifications?|depository|registrar|bank|services?|support|billing|payroll|careers?|jobs|sales|marketing|newsletter|news|alerts?)\b/i;

function classifyFromKind(parsed: ParsedFrom | null): SenderKind {
  if (!parsed) return "unknown";
  const { localPart, domain, displayName } = parsed;

  if (isAutomatedEnvelopeLocal(localPart)) return "service";

  if (KNOWN_SERVICE_DOMAINS.has(domain) || domain.endsWith(".linkedin.com")) return "service";

  // Ambiguous, so `unknown`. See `docs/reference/triage.md` (#1187).
  if (WEAK_SERVICE_LOCAL.has(localPart)) return "unknown";

  // An exact group local beats a display name. Exact only: `dev.patel@` is a person.
  if (isExactGroupLocal(localPart)) return "unknown";

  // Same order as `classifyEntityKind`, so triage is not stricter than the set's owner.
  if (isLikelyPersonDisplayName(displayName)) return "person";

  if (FIRST_LAST_LOCAL_RE.test(localPart)) return "person";

  return "unknown";
}

function isLikelyPersonDisplayName(displayName: string | null): boolean {
  if (!displayName || !/\s/.test(displayName)) return false;

  if (ORG_DISPLAY_TOKEN_RE.test(displayName)) return false;

  return true;
}

/**
 * A real person on a service domain (`jane.doe@google.com`). For the team graph
 * only; triage keeps the service verdict.
 */
export function isHumanLikeSender(localPart: string, displayName: string | null): boolean {
  if (isAutomatedEnvelopeLocal(localPart)) return false;

  return isLikelyPersonDisplayName(displayName) || FIRST_LAST_LOCAL_RE.test(localPart);
}

// ---------------------------------------------------------------------------
// Body-actor parsers
// ---------------------------------------------------------------------------

type BodyActor = NonNullable<SenderContext["bodyActor"]>;

type ParserHit = "github" | "calendar" | "linear";

interface BodyActorDispatch {
  actor: BodyActor | undefined;
  parserHit: ParserHit | null;
}

function parseBodyActor(domain: string, localPart: string, body: string): BodyActorDispatch {
  if (isGithubDomain(domain)) {
    const actor = parseGithubBodyActor(body);

    return { actor, parserHit: actor ? "github" : null };
  }

  if (isCalendarSender(domain, localPart)) {
    const actor = parseCalendarBodyActor(body);

    return { actor, parserHit: actor ? "calendar" : null };
  }

  if (isLinearDomain(domain)) {
    const actor = parseLinearBodyActor(body);

    return { actor, parserHit: actor ? "linear" : null };
  }

  return { actor: undefined, parserHit: null };
}

function isGithubDomain(domain: string): boolean {
  return (
    domain === "github.com" || domain === "noreply.github.com" || domain.endsWith(".github.com")
  );
}

function isLinearDomain(domain: string): boolean {
  return domain === "linear.app" || domain.endsWith(".linear.app");
}

function isCalendarSender(domain: string, localPart: string): boolean {
  if (domain !== "google.com" && !domain.endsWith(".google.com")) return false;

  return localPart === "calendar-notification" || localPart.startsWith("calendar-");
}

function unwrapBold(s: string): string {
  return s
    .trim()
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

const GITHUB_BOLD_RE = /\*\*([^*\n]{1,80})\*\*/;

const GITHUB_BOT_SUFFIX_RE = /^(.+?)\s*\[bot\]\s*$/i;

function githubDisplayNameBot(parsed: ParsedFrom): BodyActor | undefined {
  if (!isGithubDomain(parsed.domain) || !parsed.displayName) return undefined;
  const handle = parsed.displayName.match(GITHUB_BOT_SUFFIX_RE)?.[1]?.trim().toLowerCase();

  return handle ? { kind: "bot", name: parsed.displayName, handle } : undefined;
}

function parseGithubBodyActor(body: string): BodyActor | undefined {
  const head = body.split(/\r?\n/).slice(0, 12).join("\n");
  const m = head.match(GITHUB_BOLD_RE);
  const inner = m?.[1];

  if (!inner) return undefined;
  const raw = unwrapBold(inner);

  if (!raw) return undefined;
  const botMatch = raw.match(GITHUB_BOT_SUFFIX_RE);
  const botName = botMatch?.[1];

  if (botName) {
    return { kind: "bot", name: raw, handle: botName.trim().toLowerCase() };
  }

  return { kind: "person", name: raw, handle: raw.toLowerCase() };
}

const ICAL_ORGANIZER_RE = /ORGANIZER(?:;[^:\n]*?CN="?([^";:\n]+)"?)?[^:\n]*:mailto:([^\s>;]+)/i;

const PLAIN_ORGANIZER_RE = /^\s*organizer:\s*(.+)$/im;

const ANGLE_NAME_RE = /^(.+?)\s*<([^>]+)>\s*$/;

function parseCalendarBodyActor(body: string): BodyActor | undefined {
  const ical = body.match(ICAL_ORGANIZER_RE);

  if (ical) {
    const cn = ical[1]?.trim();
    const email = ical[2]?.trim().toLowerCase();

    if (email) {
      const name = cn || email.split("@")[0] || email;

      return { kind: "person", name, handle: email };
    }
  }

  const plain = body.match(PLAIN_ORGANIZER_RE);
  const plainRaw = plain?.[1]?.trim();

  if (plainRaw) {
    const angle = plainRaw.match(ANGLE_NAME_RE);
    const angleEmail = angle?.[2];

    if (angleEmail) {
      const name = (angle?.[1] ?? "")
        .trim()
        .replace(/^"+|"+$/g, "")
        .trim();

      const handle = angleEmail.trim().toLowerCase();

      return { kind: "person", name: name || handle, handle };
    }

    return { kind: "person", name: plainRaw, handle: plainRaw.toLowerCase() };
  }

  return undefined;
}

const LINEAR_COMMENT_FROM_RE = /comment\s+from\s+([^\n<(]{1,80})/i;

const LINEAR_COMMENTED_RE = /^([^\n<(]{1,80}?)\s+commented(?:\s+on)?/im;

function parseLinearBodyActor(body: string): BodyActor | undefined {
  const head = body.split(/\r?\n/).slice(0, 30).join("\n");
  const m1 = head.match(LINEAR_COMMENT_FROM_RE);
  const m1Name = m1?.[1]?.trim();

  if (m1Name) return { kind: "person", name: m1Name, handle: m1Name.toLowerCase() };
  const m2 = head.match(LINEAR_COMMENTED_RE);
  const m2Name = m2?.[1]?.trim();

  if (m2Name) return { kind: "person", name: m2Name, handle: m2Name.toLowerCase() };

  return undefined;
}

// ---------------------------------------------------------------------------
// Bot-slug resolution
// ---------------------------------------------------------------------------

function resolveBotSlug(args: {
  domain: string | null;
  localPart: string | null;
  bodyActor: BodyActor | undefined;
}): BotSlug | undefined {
  const { domain, localPart, bodyActor } = args;

  if (!domain) return undefined;

  // All GitHub mail shares one envelope, so the handle names the bot.
  if (isGithubDomain(domain)) {
    const handle = bodyActor?.handle?.toLowerCase();

    if (!handle) return undefined;

    if (handle.startsWith("coderabbitai")) return "coderabbit";

    if (handle.startsWith("copilot-pull-request-reviewer") || handle.startsWith("github-copilot")) {
      return "copilot-review";
    }

    if (handle === "github-actions" || handle.startsWith("github-actions")) {
      return "github-actions";
    }

    if (handle === "dependabot" || handle.startsWith("dependabot")) return "dependabot";

    if (handle === "renovate" || handle.startsWith("renovate")) return "renovate";

    return undefined;
  }

  if (domain === "sentry.io" || domain.endsWith(".sentry.io")) return "sentry";

  if (domain === "stripe.com" || domain === "stripe.email" || domain.endsWith(".stripe.com")) {
    return "stripe-billing";
  }

  if (domain === "accounts.google.com") return "google-security";

  if (
    (domain === "google.com" || domain.endsWith(".google.com")) &&
    localPart &&
    /security|signin|sign-in|verification/i.test(localPart)
  ) {
    return "google-security";
  }

  if (domain === "vercel.com" || domain === "vercel-app.com" || domain.endsWith(".vercel.com")) {
    return "vercel";
  }

  if (domain === "datadoghq.com" || domain === "datadog.com" || domain.endsWith(".datadoghq.com")) {
    return "datadog";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Effective-author derivation
// ---------------------------------------------------------------------------

function deriveEffectiveAuthor(args: {
  fromKind: SenderKind;
  bodyActor: BodyActor | undefined;
  botSlug: BotSlug | undefined;
}): EffectiveAuthor {
  // CodeRabbit can omit `[bot]`; the slug still marks it.
  if (args.botSlug) return "bot";
  const ba = args.bodyActor;

  if (ba?.kind === "bot") return "bot";

  if (ba?.kind === "person") return "person";

  if (args.fromKind === "person") return "person";

  if (args.fromKind === "service") return "service";

  return "unknown";
}
