import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { FREE_MAIL_DOMAINS, isFreeMail } from "@alfred/contracts";
import { and, asc, eq } from "drizzle-orm";

/**
 * Identity signals fed to cold-start research (ADR-0011). The shape grows
 * naturally as integrations land — each connected provider can contribute
 * its own branch to {@link collectColdStartSignals}.
 *
 * v1 only contributes the always-present user row + Google. GitHub /
 * personal site / social handles per ADR-0011 arrive when those
 * integrations exist.
 */
export interface ColdStartSignals {
  userId: string;
  /** From the `user` row — the user's display name as captured at signup. */
  name: string;
  email: string;
  /**
   * Lower-cased domain portion of `email`. `null` for malformed emails or
   * when the user hasn't confirmed an email yet (defensive — should be
   * unreachable since signup requires a verified address).
   */
  emailDomain: string | null;
  /** Free / personal-mail providers we don't research as "company." */
  emailDomainIsConsumer: boolean;
  /** Connected providers and what they contributed. */
  integrations: {
    google?: { accountEmail: string };
    // Future: github, linear, slack, …
  };
}

/**
 * Common consumer email domains — re-exported from the ONE canonical free-mail
 * set (`@alfred/contracts` `FREE_MAIL_DOMAINS`, ADR-0080 §4b). Kept under the old
 * name so existing imports keep working; the list itself now lives in contracts
 * (the identity domain classifier's source of truth) so cold-start and the
 * identity projection can never drift two parallel lists (#330 "no second
 * registry", applied to domains). Matching here flips `emailDomainIsConsumer`,
 * which tells the cold-start prompt not to research "what does gmail.com do as a
 * company."
 */
export const CONSUMER_EMAIL_DOMAINS = FREE_MAIL_DOMAINS;

function parseDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Is `domain` a free/consumer mailbox (gmail.com, icloud.com, …) rather than
 * an organization domain? Used by passive team-graph capture (ADR-0059 P4a) to
 * avoid minting a bogus `organization` entity per personal mailbox — a consumer
 * domain is not the contact's employer. Delegates to the canonical
 * {@link isFreeMail} classifier so it stays in lockstep with the identity
 * projection's domain classification.
 */
export function isConsumerEmailDomain(domain: string | null | undefined): boolean {
  return isFreeMail(domain);
}

/**
 * Walk all evidence we have about who this user is. Idempotent and safe
 * to call many times — does not mutate state, only reads.
 *
 * Intended call site is the cold-start workflow's first step. The
 * workflow's job is to fail loudly if this returns no usable signal
 * (e.g. somehow no user row), since research on `{}` is just expensive
 * noise.
 */
export async function collectColdStartSignals(userId: string): Promise<ColdStartSignals> {
  const userRows = await db()
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const u = userRows[0];
  if (!u) throw new Error(`[cold-start] user ${userId} not found`);

  const emailDomain = parseDomain(u.email);
  const emailDomainIsConsumer = emailDomain != null && CONSUMER_EMAIL_DOMAINS.has(emailDomain);

  const integrations: ColdStartSignals["integrations"] = {};

  // The schema explicitly allows multiple Google accounts per user
  // (work + personal Gmail). Order by `createdAt` ASC so the oldest
  // active credential wins — at signup that's trivially the only one
  // (callback just inserted it), and on a future re-research it's the
  // original onboarding credential, which is the most defensible
  // anchor for "who are you" research.
  const googleRows = await db()
    .select({
      accountLabel: integrationCredentials.accountLabel,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, userId),
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.status, "active"),
      ),
    )
    .orderBy(asc(integrationCredentials.createdAt))
    .limit(1);
  const google = googleRows[0];
  if (google?.accountLabel) {
    integrations.google = { accountEmail: google.accountLabel };
  }

  return {
    userId,
    name: u.name,
    email: u.email,
    emailDomain,
    emailDomainIsConsumer,
    integrations,
  };
}
