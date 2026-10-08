import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { FREE_MAIL_DOMAINS } from "@alfred/contracts";
import { and, asc, eq } from "drizzle-orm";

/** Identity evidence for cold-start research (ADR-0011). */
export interface ColdStartSignals {
  userId: string;
  name: string;
  email: string;
  /** Lowercased domain of `email`, or `null` when the email is malformed. */
  emailDomain: string | null;
  /** True for a free-mail domain, which has no company to research. */
  emailDomainIsConsumer: boolean;
  integrations: {
    google?: { accountEmail: string } | undefined;
  };
}

/** The one free-mail list (ADR-0080 §4b), shared with the identity projection. */
const CONSUMER_EMAIL_DOMAINS = FREE_MAIL_DOMAINS;

function parseDomain(email: string): string | null {
  const at = email.lastIndexOf("@");

  if (at < 0 || at === email.length - 1) return null;

  return email.slice(at + 1).toLowerCase();
}

/** Read-only. */
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

  // A user can have several Google accounts. The oldest active one is the signup account.
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
