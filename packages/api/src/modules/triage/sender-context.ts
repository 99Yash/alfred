/**
 * Deterministic sender-context extraction (ADR-0042 micro-decision #1).
 *
 * Pure function. Zero LLM cost, ~5ms. Runs as the head step of the triage
 * workflow so the cheap-tier classifier downstream receives a typed
 * `SenderContext` instead of having to re-parse `From:` headers in prose.
 *
 * Coverage policy: grow the bot allowlist and per-service body-actor
 * parsers from observed `triage.classification` decision traces,
 * never speculation. v1 covers GitHub, Google Calendar, and Linear — the
 * three sources that hit ~80% of bot/human disambiguation in real inboxes.
 *
 * Anything we can't classify deterministically falls through to
 * `effectiveAuthor: 'unknown'`, which the deepen gate (`confidence < 0.7`
 * clause) treats as the safety net.
 */

import {
  type BotSlug,
  type EffectiveAuthor,
  type SenderContext,
  type SenderKind,
} from "@alfred/contracts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ExtractSenderContextArgs {
  /** Raw `From:` header value, e.g. `'CodeRabbit <noreply@github.com>'`. */
  fromHeader: string | null;
  subject: string | null;
  /** Plain-text body. The GitHub/Calendar/Linear parsers all run against this. */
  body: string;
}

export interface SenderContextResult {
  context: SenderContext;
  /** Which body-actor parser produced `context.bodyActor`, if any. Drives the observability event. */
  parserHit: "github" | "calendar" | "linear" | null;
  /** Normalized lowercase `local@domain`. Null if `From:` was unparseable. */
  senderAddress: string | null;
  /** Normalized lowercase domain. Null if `From:` was unparseable. */
  senderDomain: string | null;
}

export function extractSenderContext(args: ExtractSenderContextArgs): SenderContextResult {
  const parsed = parseFromHeader(args.fromHeader);
  const senderAddress = parsed?.address ?? null;
  const senderDomain = parsed?.domain ?? null;
  const fromKind = classifyFromKind(parsed);

  const dispatch: BodyActorDispatch = parsed
    ? parseBodyActor(parsed.domain, parsed.localPart, args.body)
    : { actor: undefined, parserHit: null };

  let bodyActor = dispatch.actor;
  let parserHit = dispatch.parserHit;

  // GitHub marks every bot account with a `[bot]` display-name suffix (its own
  // universal convention — `greptile-apps[bot]`, `dependabot[bot]`, …). The
  // body-actor parser only reads `**bold**` actor lines in the body, so a PR
  // review notification whose actor lives only in the `From:` display name
  // (`"greptile-apps[bot]" <notifications@github.com>`) falls through to
  // `effectiveAuthor=service`, leaving the classifier no reliable bot signal.
  // Recognize the `[bot]` suffix on a github.com envelope structurally (NOT a
  // hand-maintained slug list — it generalizes to any current/future bot) so
  // advisory review mail is reliably tagged `effectiveAuthor=bot`. The body
  // parser still wins when it fired; this only fills the gap. ADR-0050/0051
  // amendment 2026-06-09.
  if (!bodyActor && parsed && isGithubDomain(parsed.domain) && parsed.displayName) {
    const m = parsed.displayName.match(GITHUB_BOT_SUFFIX_RE);
    const handle = m?.[1]?.trim().toLowerCase();
    if (handle) {
      bodyActor = { kind: "bot", name: parsed.displayName, handle };
      parserHit = "github";
    }
  }

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
  /** Lowercased `local@domain`. */
  address: string;
  /** Lowercased portion before `@`. */
  localPart: string;
  /** Lowercased portion after `@`. */
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
// fromKind classification
// ---------------------------------------------------------------------------

/**
 * Local parts that unambiguously identify the address as a service envelope.
 * The set is intentionally conservative — soft markers like `info`, `team`,
 * `hello`, `billing`, `security` fall through to the WEAK set below because
 * those can be staffed mailboxes at small companies.
 */
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

/** Locals that *might* be services but aren't on the unknown domain. */
const WEAK_SERVICE_LOCAL = new Set<string>([
  "info",
  "team",
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

/**
 * Domains that always ride as a service envelope regardless of local part.
 * Add per observed evidence — a "person@github.com" wouldn't make it through
 * the human reality check anyway. Subdomain matches are handled in code.
 */
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
]);

const SERVICE_LOCAL_PREFIX_RE =
  /^(no[-_.]?reply|donotreply|do[-_]not[-_]reply|notification|notifications|alerts?|security[-_]|billing[-_]|account[-_]|calendar[-_])/;

const FIRST_LAST_LOCAL_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/i;
const ORG_DISPLAY_TOKEN_RE =
  /\b(inc|incorporated|ltd|limited|llc|llp|gmbh|plc|corp|corporation|company|co|team|notifications?|depository|registrar|bank|services?|support|billing|payroll|careers?|jobs|sales|marketing|newsletter|news|alerts?)\b/i;

function classifyFromKind(parsed: ParsedFrom | null): SenderKind {
  if (!parsed) return "unknown";
  const { localPart, domain, displayName } = parsed;
  if (STRONG_SERVICE_LOCAL.has(localPart)) return "service";
  if (SERVICE_LOCAL_PREFIX_RE.test(localPart)) return "service";
  if (KNOWN_SERVICE_DOMAINS.has(domain)) return "service";
  // Weak service markers (`info`, `team`, `support`) on an *unknown* domain
  // are genuinely ambiguous — could be a small-company staffed mailbox or a
  // service envelope. Default to 'unknown' so the deepen gate's low-confidence
  // path catches it instead of an over-eager service classification.
  if (WEAK_SERVICE_LOCAL.has(localPart)) return "unknown";
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
 * The "human reality check" the `KNOWN_SERVICE_DOMAINS` note above references.
 *
 * `classifyFromKind` deliberately tags whole service domains (`google.com`,
 * `github.com`, …) as `service` for inbox triage, which is right there but
 * wrong for the team-graph extractor: a real colleague at `jane.doe@google.com`
 * must still become a `person` node. This predicate answers "does this address
 * look like a real human despite riding a service domain?" — a strong person
 * signal (a person-like display name OR a `first.last` local part) qualifies,
 * UNLESS the local part is an unambiguous automated envelope (`noreply@`,
 * `notifications@`, …). It reuses the same constants the classifier ranks
 * above the domain check, so the two stay in lockstep. Triage classification is
 * intentionally left untouched (its eval lane depends on the current ordering);
 * only the graph extractor opts into the rescue.
 */
export function isHumanLikeSender(localPart: string, displayName: string | null): boolean {
  if (STRONG_SERVICE_LOCAL.has(localPart)) return false;
  if (SERVICE_LOCAL_PREFIX_RE.test(localPart)) return false;
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

/**
 * Strip wrapping bold markers, trim whitespace. Used so a body line like
 * `**dependabot[bot]**` collapses to `dependabot[bot]` before suffix tests.
 */
function unwrapBold(s: string): string {
  return s
    .trim()
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

const GITHUB_BOLD_RE = /\*\*([^*\n]{1,80})\*\*/;
const GITHUB_BOT_SUFFIX_RE = /^(.+?)\s*\[bot\]\s*$/i;

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

  // GitHub: bot identity comes from the body-actor handle, not the envelope —
  // all GitHub notifications share `noreply@github.com`.
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
  // A recognized bot slug is the most specific signal: GitHub apps like
  // CodeRabbit don't always emit the `[bot]` suffix in the body, but the
  // handle match still pins them as bots.
  if (args.botSlug) return "bot";
  const ba = args.bodyActor;
  if (ba?.kind === "bot") return "bot";
  if (ba?.kind === "person") return "person";
  if (args.fromKind === "person") return "person";
  if (args.fromKind === "service") return "service";
  return "unknown";
}
