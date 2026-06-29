/**
 * Identity-affiliation deterministic core (ADR-0080, #218 / `docs/plans/identity-facts-projection-v1.md`).
 *
 * The provably-correct primitives the identity-facts PROJECTION composes — kept
 * here, pure and unit-tested, because ADR-0080 invariant 3 ("deterministic core,
 * LLM at the edges") makes them the safety floor: an LLM may *propose* candidate
 * observations, but it never decides authoritative identity. Three pieces:
 *
 *   1. the DOMAIN CLASSIFIER (§4b) — a connected-account email domain into one of
 *      four employer-signal outcomes, deterministically;
 *   2. the GROUNDING-TIER ladder + authority RANKING (§5) — the closed, ordered
 *      provenance vocabulary the projection ranks candidate values by (it reads
 *      `groundingTier`, NOT the flat `source.kind="projection"` writer tag);
 *   3. the per-key GROUNDING RULE (§5) — which tier may ground which identity key
 *      (a corporate domain grounds `employer` but NOT `job_title`/`team`/`manager`;
 *      `weak_mentions` is evidence that never promotes — invariant 6).
 *
 * Pure module — no Node imports (consumed across the web boundary, same rule as
 * `user-model.ts`, from which it borrows `FactKey`).
 */

import { z } from "zod";
import { type FactKey } from "./user-model.js";

// ───────────────────────────────────────────────────────────────────────────
// Domain classifier (ADR-0080 §4b) — the connected-account employer signal
// ───────────────────────────────────────────────────────────────────────────

/**
 * The four employer-signal outcomes a domain (or full address) classifies into.
 * This is the structural gate that decides whether a `user_org_affiliation`
 * observation can ground `employer` at all — see {@link affiliationGroundingTier}.
 */
export const DOMAIN_CLASSES = [
  /** Free / personal mailbox (gmail, icloud, proton, …). No employer signal. */
  "consumer_email",
  /** A real organization domain (oliv.ai, acme.com). Strong org affiliation; may auto-confirm `employer` when uncontradicted. */
  "corporate_domain",
  /** School / alumni / agency / shared-hosting / disposable / personal custom. Affiliation maybe; `employer` requires corroboration. */
  "ambiguous_domain",
  /** Role / service mailbox (noreply@, support@, a bounce/mailer host). Never an employer. */
  "service_or_role_account",
] as const;
export const domainClassSchema = z.enum(DOMAIN_CLASSES);
export type DomainClass = (typeof DOMAIN_CLASSES)[number];

/**
 * Free / consumer mailbox providers (the `consumer_email` set). This is the old
 * cold-start `CONSUMER_EMAIL_DOMAINS` list moved here, not expanded in the same
 * slice, so deduping the registry does not change cold-start behavior. A consumer
 * domain is never the subject's employer, so a `user_org_affiliation` over one
 * grounds nothing. Extend this set in a behavior-changing PR with corpus examples.
 */
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

/**
 * Disposable / throwaway mailbox domains — `ambiguous_domain`, never a corporate
 * signal. Kept short on purpose (a missed entry only costs a wasted corroboration
 * requirement, never a wrong `employer`); extend as real cases appear.
 */
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
 * Shared-hosting / site-builder suffixes whose child names anyone can claim
 * (`alice.github.io`, `acme.wixsite.com`). A child domain under one of these is
 * `ambiguous_domain` — the registrable domain belongs to the host, not the
 * subject's employer. Matched as a PROPER suffix only, so `github.com` itself can
 * still be a corporate employer while `alice.github.io` cannot.
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

/**
 * Local-part tokens that mark a NON-personal role / service / automated mailbox
 * (`noreply@`, `support@`, `billing@`). An address with one of these local parts
 * is `service_or_role_account` regardless of its domain class — it is never a
 * person whose employer we can assert. Matched on the WHOLE local part and on its
 * hyphen/dot/underscore-split tokens (so `no-reply`, `no_reply`, `team.support`).
 */
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
 * Apex/host-name tokens that mark a SENDING-SERVICE / bounce domain (the domain
 * itself is infrastructure, not an org the user works at): `bounce.acme.com`,
 * `email.notifications.foo.com`, `mailer.x.io`. Matched as a leading domain label.
 */
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

/** Tokens in a domain that hint at school / alumni / agency / personal — `ambiguous_domain`. */
const AMBIGUOUS_DOMAIN_TOKENS: readonly string[] = ["alumni", "alum", "students", "student"];
// Mirrors the hostname floor in user-model.ts without importing it at runtime:
// identity-affiliation feeds user-model's observation schema, so it must not
// create a value-level cycle back into that module.
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DNS_TLD = `(?=[a-z0-9-]*[a-z])${DNS_LABEL}`;
const HOSTNAME = new RegExp(`^(?=[^@]{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*\\.${DNS_TLD}$`);

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

function isValidDomain(domain: string): boolean {
  return HOSTNAME.test(domain);
}

function isValidEmailLocalPart(localPart: string): boolean {
  for (const ch of localPart) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || ch === "@" || /\s/u.test(ch)) return false;
  }
  return true;
}

/** Split a raw address into `{ localPart, domain }`, lowercased; null if not an address. */
function splitEmail(email: string): { localPart: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  if (at !== trimmed.lastIndexOf("@")) return null;
  const localPart = trimmed.slice(0, at);
  if (!isValidEmailLocalPart(localPart)) return null;
  return { localPart, domain: normalizeDomain(trimmed.slice(at + 1)) };
}

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
  // Any token of a delimited local part (`team.billing`, `no-reply`) being a role word.
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

export interface ClassifyDomainInput {
  /** A full email address — its local part is checked for role/service mailboxes. */
  readonly email?: string | null;
  /** A bare domain (used when no address is available — e.g. an org domain on its own). */
  readonly domain?: string | null;
  /**
   * Verified hosted/workspace domain for the account, when the provider exposes
   * one (Google's `hd` claim). For a full email address, a custom domain without
   * this corroboration is ambiguous rather than an auto-grounding employer.
   */
  readonly verifiedHostedDomain?: string | null;
}

/**
 * Classify a connected-account address / domain into its employer-signal outcome
 * (ADR-0080 §4b). DETERMINISTIC — same input always yields the same class, so a
 * projection replay converges and the class is unit-testable without a DB or LLM.
 *
 * Precedence (first match wins):
 *   1. a role/service LOCAL PART or service host  → `service_or_role_account`
 *      (checked first: `noreply@acme.com` is a service mailbox, not employment at Acme);
 *   2. a free-mail domain                         → `consumer_email`;
 *   3. an academic / alumni / shared-hosting / disposable domain → `ambiguous_domain`;
 *   4. otherwise                                  → `corporate_domain`.
 *
 * A bare domain is treated as an org-domain candidate. A full email address gets
 * the stricter connected-account rule: a custom non-free address is corporate
 * only when the provider also verifies that hosted domain (e.g. Google `hd`).
 * Without that corroboration, personal custom domains stay ambiguous.
 */
export function classifyEmailDomain(input: ClassifyDomainInput): DomainClass | null {
  const parsed = input.email ? splitEmail(input.email) : null;
  const domain = parsed ? parsed.domain : input.domain ? normalizeDomain(input.domain) : null;
  if (!domain) return null;
  if (!isValidDomain(domain)) return null;

  if (parsed && isRoleServiceLocalPart(parsed.localPart)) return "service_or_role_account";
  if (isFreeMailDomain(domain)) return "consumer_email";
  if (isServiceDomain(domain)) return "service_or_role_account";
  if (isAmbiguousDomain(domain)) return "ambiguous_domain";
  if (parsed) {
    const verifiedHostedDomain = input.verifiedHostedDomain
      ? normalizeDomain(input.verifiedHostedDomain)
      : null;
    return verifiedHostedDomain === domain ? "corporate_domain" : "ambiguous_domain";
  }
  return "corporate_domain";
}

/** True iff `domain` (or the domain of an address) is a free/consumer mailbox provider. */
export function isFreeMail(domainOrEmail: string | null | undefined): boolean {
  if (!domainOrEmail) return false;
  const parsed = domainOrEmail.includes("@") ? splitEmail(domainOrEmail) : null;
  const domain = parsed ? parsed.domain : normalizeDomain(domainOrEmail);
  return isFreeMailDomain(domain);
}

// ───────────────────────────────────────────────────────────────────────────
// Grounding tiers + authority ranking (ADR-0080 §5)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The closed, ORDERED provenance vocabulary the identity projection ranks
 * candidate values by (strongest first). Projection-owned `user_facts` rows carry
 * `source.kind="projection"` as a WRITER TAG ONLY — authority is read from this
 * tier (+ the underlying observation source in `derivedFrom`), never the flat
 * `"projection"` source. That keeps a Directory-grounded employer strictly above
 * a footer-inferred one (the rejected alternative (c) in ADR-0080).
 *
 * Order IS the rank (index 0 = strongest). `weak_mentions` is the floor: it is
 * EVIDENCE, and {@link canGroundIdentityKey} never lets it promote (invariant 6).
 */
export const GROUNDING_TIERS = [
  /** Explicit `source=user` correction ("I left", "that's a client"). Highest. */
  "user_correction",
  /** A `/settings` profile edit (`source=user`/`alfred_chat`, `user_profile_edit`). */
  "user_profile_edit",
  /** Verified Workspace Directory org membership (the P3 reducer). */
  "directory_verified",
  /** Current corporate-domain org affiliation from a connected account (§4a). */
  "corporate_affiliation",
  /** The user's own signature / public profile bio they authored. */
  "self_authored_profile_or_signature",
  /** Corroborated public research / cold-start. */
  "corroborated_public_or_cold_start",
  /** A bare mention in third-party content. Evidence only — never promotes. */
  "weak_mentions",
] as const;
export const groundingTierSchema = z.enum(GROUNDING_TIERS);
export type GroundingTier = (typeof GROUNDING_TIERS)[number];

/** Rank for each tier (lower = stronger), derived from {@link GROUNDING_TIERS} order. */
export const GROUNDING_TIER_RANK: Readonly<Record<GroundingTier, number>> = Object.fromEntries(
  GROUNDING_TIERS.map((tier, i) => [tier, i]),
) as Record<GroundingTier, number>;

export function groundingTierRank(tier: GroundingTier): number {
  return GROUNDING_TIER_RANK[tier];
}

/** True iff `a` is a STRICTLY stronger grounding than `b` (lower rank wins). */
export function isStrongerGrounding(a: GroundingTier, b: GroundingTier): boolean {
  return groundingTierRank(a) < groundingTierRank(b);
}

// ───────────────────────────────────────────────────────────────────────────
// Per-key grounding rule (ADR-0080 §5) — which tier may ground which key
// ───────────────────────────────────────────────────────────────────────────

/**
 * The identity keys the projection OWNS (a subset of `FACT_ONTOLOGY`). Slice 1a
 * activates only `employer`; the rest land in slice 1b reusing the same reducer
 * + ranking, so the list lives here now and the slice gate (api side) decides
 * which are live. Every entry is asserted to be a real `FactKey`.
 */
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

export function isProjectionIdentityKey(key: string): key is ProjectionIdentityKey {
  return (PROJECTION_IDENTITY_KEYS as readonly string[]).includes(key);
}

/**
 * Keys a `corporate_affiliation` tier ALONE may ground (ADR-0080 §5). A corporate
 * email domain grounds `employer` and nothing else: `job_title` / `team` /
 * `manager` are NOT grounded by a domain (they need Directory, a user
 * correction/edit, a self-authored profile, or corroborated first-party
 * evidence); `location` / profile URLs need direct user-subject evidence.
 */
const CORPORATE_AFFILIATION_GROUNDABLE: ReadonlySet<ProjectionIdentityKey> = new Set(["employer"]);

/**
 * True iff a candidate at grounding `tier` may MATERIALIZE identity `key` (ADR-0080
 * §5). The two structural rules:
 *
 *   - `weak_mentions` grounds NOTHING — it is evidence, and "evidence-only never
 *     promotes" (invariant 6). `mentioned_company` stays raw.
 *   - `corporate_affiliation` grounds ONLY `employer` — a domain does not ground
 *     a title/team/manager/location/url.
 *
 * Every stronger/direct tier (`user_*`, `directory_verified`,
 * `self_authored_profile_or_signature`, `corroborated_public_or_cold_start`)
 * grounds any owned key; ABOUTNESS (subjectIdentity = user) is enforced
 * structurally upstream (invariant 2), not here.
 */
export function canGroundIdentityKey(tier: GroundingTier, key: ProjectionIdentityKey): boolean {
  if (tier === "weak_mentions") return false;
  if (tier === "corporate_affiliation") return CORPORATE_AFFILIATION_GROUNDABLE.has(key);
  return true;
}

/**
 * The grounding tier a `user_org_affiliation` observation of a given domain class
 * carries (ADR-0080 §4a/§4b), or `null` when the class grounds nothing on its own:
 *
 *   - `corporate_domain`         → `corporate_affiliation` (may auto-confirm `employer`);
 *   - `consumer_email`           → null (no employer signal);
 *   - `service_or_role_account`  → null (never an employer);
 *   - `ambiguous_domain`         → null (affiliation maybe, but `employer` needs
 *                                  corroboration — the corroboration upgrade is a
 *                                  later slice, so alone it grounds nothing now).
 *
 * Returning `null` is the "no grounding, no row" contract (invariant 1) in code:
 * absent a corporate domain, the projection materializes no `employer` from a
 * connected account.
 */
export function affiliationGroundingTier(domainClass: DomainClass): GroundingTier | null {
  return domainClass === "corporate_domain" ? "corporate_affiliation" : null;
}
