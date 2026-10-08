/**
 * Deterministic identity-affiliation core (ADR-0080). An LLM may propose observations;
 * these rules decide identity. Pure module: the web client imports it.
 */

import { z } from "zod";
import { isValidDomain, normalizeDomain, splitEmail } from "./domain";
import { enumGuard } from "./guards";
import { type FactKey } from "./user-model";

// Domain classifier (ADR-0080 §4b)

/** Employer-signal classes for a domain or address. Only `corporate_domain` can ground `employer`. */
export const DOMAIN_CLASSES = [
  "consumer_email",
  "corporate_domain",
  /** School, alumni, shared hosting, disposable, or personal custom domain. */
  "ambiguous_domain",
  /** Role or service mailbox, e.g. noreply@. */
  "service_or_role_account",
] as const;

export const domainClassSchema = z.enum(DOMAIN_CLASSES);

export type DomainClass = (typeof DOMAIN_CLASSES)[number];

/** Free consumer mailbox domains. Cold-start reads this set too, so adding a domain changes its behavior. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "hotmail.com",
  "live.com",
  // Yahoo / AOL
  "yahoo.com",
  "yahoo.co.uk",
  "aol.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // Proton
  "proton.me",
  "protonmail.com",
  "pm.me",
  // Other common consumer/free providers
  "fastmail.com",
  "duck.com",
]);

/** Disposable mailbox domains. Short on purpose: a miss stays ambiguous, never a wrong `employer`. */
const DISPOSABLE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "trashmail.com",
  "yopmail.com",
  "getnada.com",
  "sharklasers.com",
  "maildrop.cc",
]);

/**
 * Hosts where anyone can claim a child name (`alice.github.io`).
 * Proper suffix match only, so `github.com` itself can still be an employer.
 */
const SHARED_HOSTING_SUFFIXES: readonly string[] = [
  "github.io",
  "gitlab.io",
  "wixsite.com",
  "weebly.com",
  "squarespace.com",
  "wordpress.com",
  "blogspot.com",
  "netlify.app",
  "vercel.app",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "sites.google.com",
  "notion.site",
];

/** Role or service local parts. Matched on the whole local part and on each `.`/`_`/`-` token. */
const ROLE_SERVICE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "reply",
  "mailer",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "bounces",
  "notification",
  "notifications",
  "notify",
  "alert",
  "alerts",
  "support",
  "help",
  "helpdesk",
  "service",
  "services",
  "info",
  "contact",
  "hello",
  "admin",
  "administrator",
  "root",
  "webmaster",
  "billing",
  "invoices",
  "accounts",
  "sales",
  "marketing",
  "team",
  "newsletter",
  "news",
  "updates",
  "security",
  "abuse",
]);

/**
 * A service word as the last separated token (`messages-noreply`, `nse_alerts`, `x.update`).
 * Without this, a joined local part parsed as a first.last person name (#1097, #1100).
 * A separator is required, so a staffed bare `news@` mailbox is not forced to a service.
 */
const SERVICE_WORD_SUFFIX_RE =
  /[-_.](?:no[-_]?reply|donotreply|do[-_]not[-_]reply|alerts?|notifications?|newsletters?|news|updates?)$/i;

/**
 * True when the last separated token of a local part is a service word.
 * Kept out of `isRoleServiceLocalPart`: adding `news` there would change affiliation grounding.
 */
export function hasServiceWordSuffix(localPart: string): boolean {
  return SERVICE_WORD_SUFFIX_RE.test(localPart);
}

/** First domain labels that mark mail infrastructure, e.g. `bounce.acme.com`. */
const SERVICE_DOMAIN_LABELS: ReadonlySet<string> = new Set([
  "noreply",
  "no-reply",
  "bounce",
  "bounces",
  "mailer",
  "mail",
  "email",
  "smtp",
  "mta",
  "notifications",
  "notification",
  "notify",
  "send",
  "sendgrid",
  "mailgun",
]);

const EDU_TLDS: readonly string[] = [".edu"];

// Academic second-level domains across ccTLDs: ac.uk, edu.au, ac.in, edu.sg, …
const EDU_SLD_PATTERN = /\.(ac|edu)\.[a-z]{2,}$/;

/** Domain labels that mark a school or alumni domain. */
const AMBIGUOUS_DOMAIN_TOKENS: readonly string[] = ["alumni", "alum", "students", "student"];

function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain);
}

function hasParentSuffix(domain: string, suffix: string): boolean {
  return domain.endsWith(`.${suffix}`);
}

function isRoleServiceLocalPart(localPart: string): boolean {
  if (ROLE_SERVICE_LOCAL_PARTS.has(localPart)) return true;
  // A `+`-tagged role address (`support+ticket@`) keeps its base local part.
  const base = localPart.split("+", 1)[0] ?? localPart;

  if (ROLE_SERVICE_LOCAL_PARTS.has(base)) return true;

  return base.split(/[._-]/).some((token) => ROLE_SERVICE_LOCAL_PARTS.has(token));
}

function isServiceDomain(domain: string): boolean {
  const firstLabel = domain.split(".", 1)[0] ?? domain;

  return SERVICE_DOMAIN_LABELS.has(firstLabel);
}

function isAmbiguousDomain(domain: string): boolean {
  if (DISPOSABLE_MAIL_DOMAINS.has(domain)) return true;

  if (SHARED_HOSTING_SUFFIXES.some((s) => hasParentSuffix(domain, s))) return true;

  if (EDU_TLDS.some((t) => domain.endsWith(t))) return true;

  if (EDU_SLD_PATTERN.test(domain)) return true;
  const labels = domain.split(".");

  if (AMBIGUOUS_DOMAIN_TOKENS.some((t) => labels.includes(t))) return true;

  return false;
}

export interface ConnectedAccountInput {
  readonly email: string;
  /** Verified workspace domain (Google `hd`). Without it, a custom domain is only ambiguous. */
  readonly verifiedHostedDomain?: string | null;
}

export interface BareDomainInput {
  readonly domain: string;
}

function normalizeVerifiedHostedDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeDomain(value);

  return isValidDomain(normalized) ? normalized : null;
}

/** Each member forbids the other's keys, so a mixed `{ email, domain }` does not compile. */
type DeprecatedClassifyInput =
  | (ConnectedAccountInput & { readonly domain?: never })
  | (BareDomainInput & { readonly email?: never; readonly verifiedHostedDomain?: never });

function isBareDomainInput(input: DeprecatedClassifyInput): input is BareDomainInput {
  return "domain" in input;
}

/**
 * Classify a connected account (ADR-0080 §4b). A role local part wins first:
 * `noreply@acme.com` is not employment at Acme.
 * A custom domain is corporate only when it is the verified hosted domain (`hd`).
 * When `hd` is present it replaces the address domain.
 */
export function classifyConnectedAccount(input: ConnectedAccountInput): DomainClass | null {
  const parsed = splitEmail(input.email);

  if (!parsed) return null;

  const verifiedHostedDomain = normalizeVerifiedHostedDomain(input.verifiedHostedDomain);
  const domain = verifiedHostedDomain ?? parsed.domain;

  if (!isValidDomain(domain)) return null;

  if (isRoleServiceLocalPart(parsed.localPart)) return "service_or_role_account";

  if (isFreeMailDomain(domain)) return "consumer_email";

  if (isServiceDomain(domain)) return "service_or_role_account";

  if (isAmbiguousDomain(domain)) return "ambiguous_domain";

  return verifiedHostedDomain === domain ? "corporate_domain" : "ambiguous_domain";
}

/** Classify a bare domain as an org-domain candidate (ADR-0080 §4b). No `hd` check, so any other domain is corporate. */
export function classifyBareDomain(input: BareDomainInput): DomainClass | null {
  const domain = normalizeDomain(input.domain);

  if (!isValidDomain(domain)) return null;

  if (isFreeMailDomain(domain)) return "consumer_email";

  if (isServiceDomain(domain)) return "service_or_role_account";

  if (isAmbiguousDomain(domain)) return "ambiguous_domain";

  return "corporate_domain";
}

/**
 * @deprecated Use {@link classifyConnectedAccount} or {@link classifyBareDomain}.
 * `user-model.ts` still calls it.
 */
export function classifyEmailDomain(input: DeprecatedClassifyInput): DomainClass | null {
  if (isBareDomainInput(input)) return classifyBareDomain(input);

  return classifyConnectedAccount(input);
}

/** True if a domain, or the domain of an address, is a free mail provider. */
export function isFreeMail(domainOrEmail: string | null | undefined): boolean {
  if (!domainOrEmail) return false;
  const parsed = domainOrEmail.includes("@") ? splitEmail(domainOrEmail) : null;
  const domain = parsed ? parsed.domain : normalizeDomain(domainOrEmail);

  return isFreeMailDomain(domain);
}

// Grounding tiers (ADR-0080 §5)

/**
 * Provenance tiers, strongest first; the order is the rank.
 * Read authority from the tier, not from `source.kind="projection"`, which only tags the writer.
 */
export const GROUNDING_TIERS = [
  "user_correction",
  "user_profile_edit",
  "directory_verified",
  "corporate_affiliation",
  "self_authored_profile_or_signature",
  "corroborated_public_or_cold_start",
  /** Evidence only; never promotes (invariant 6). */
  "weak_mentions",
] as const;

export const groundingTierSchema = z.enum(GROUNDING_TIERS);

export type GroundingTier = (typeof GROUNDING_TIERS)[number];

/** Lower is stronger. */
export const GROUNDING_TIER_RANK: Readonly<Record<GroundingTier, number>> =
  // SAFETY: mapping the closed tuple gives one entry per tier; fromEntries erases the key type.
  Object.fromEntries(GROUNDING_TIERS.map((tier, i) => [tier, i])) as Record<GroundingTier, number>;

export function groundingTierRank(tier: GroundingTier): number {
  return GROUNDING_TIER_RANK[tier];
}

/** True if `a` is strictly stronger than `b`. */
export function isStrongerGrounding(a: GroundingTier, b: GroundingTier): boolean {
  return groundingTierRank(a) < groundingTierRank(b);
}

// Per-key grounding rule (ADR-0080 §5)

/** The identity keys the projection owns. */
export const PROJECTION_IDENTITY_KEYS = [
  "employer",
  "job_title",
  "team",
  "manager",
  "location",
  "personal_site",
  "github_username",
  "twitter_handle",
  "linkedin_url",
] as const satisfies readonly FactKey[];

export type ProjectionIdentityKey = (typeof PROJECTION_IDENTITY_KEYS)[number];

export const isProjectionIdentityKey = enumGuard(PROJECTION_IDENTITY_KEYS);

/** A corporate domain grounds `employer` only, never a title, team, or manager. */
const CORPORATE_AFFILIATION_GROUNDABLE: ReadonlySet<ProjectionIdentityKey> = new Set(["employer"]);

/**
 * True if a candidate at `tier` may materialize `key` (ADR-0080 §5).
 * The caller checks that the subject is the user (invariant 2).
 */
export function canGroundIdentityKey(tier: GroundingTier, key: ProjectionIdentityKey): boolean {
  if (tier === "weak_mentions") return false;

  if (tier === "corporate_affiliation") return CORPORATE_AFFILIATION_GROUNDABLE.has(key);

  return true;
}

/** The tier a `user_org_affiliation` of this class carries. `null` means no grounding, no row (invariant 1). */
export function affiliationGroundingTier(domainClass: DomainClass): GroundingTier | null {
  return domainClass === "corporate_domain" ? "corporate_affiliation" : null;
}
