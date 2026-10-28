import { db } from "@alfred/db";
import {
  integrationCredentials,
  user,
  type IntegrationCredential,
  type User,
} from "@alfred/db/schemas";
import { emailDomain, isFreeMail, parseEmailAddress } from "@alfred/contracts";
import { and, asc, eq } from "drizzle-orm";

/**
 * The user's own identity: the sign-in address plus every active connected Google mailbox.
 * Every check that compares an address or a domain to "the user" reads this one value.
 */
export interface UserIdentity {
  readonly name: User["name"];
  /** `user.email` as stored, the sign-in address. A later primary-mailbox rule replaces this. */
  readonly primaryEmail: User["email"];
  /**
   * Active Google `accountId` to its canonical mailbox address, in connection order
   * (`createdAt` ascending). A `Map`, not a `Record`: Google account ids are numeric strings,
   * and a `Record` would reorder them.
   */
  readonly mailboxByAccountId: ReadonlyMap<IntegrationCredential["accountId"], string>;
  /** Self addresses (`parseEmailAddress`, the self-mail matcher): `user.email` plus every mailbox. */
  readonly emails: ReadonlySet<string>;
  /** Domains of `emails`, minus free-mail domains. The same-org set (ADR-0059 §3). */
  readonly domains: ReadonlySet<string>;
}

/**
 * Read the user's identity in two parallel queries. Bind once per request, step, or job, as
 * with `settings({ userId })`. Only `active` Google credentials count. A doc whose mailbox
 * is not active has no per-account entry, so the Tier B authorship gate (ADR-0079) falls
 * back to matching every self address (`fact-policy.ts`); whether that fallback is right
 * is out of scope here. Throws when the user row is missing.
 */
export async function userIdentity({ userId }: { userId: string }): Promise<UserIdentity> {
  const [[row], creds] = await Promise.all([
    db()
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    db()
      .select({
        accountId: integrationCredentials.accountId,
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
      .orderBy(asc(integrationCredentials.createdAt)),
  ]);

  if (!row) throw new Error(`[user-identity] user ${userId} not found`);

  const mailboxByAccountId = new Map<IntegrationCredential["accountId"], string>();
  const emails = new Set<string>();
  const signIn = parseEmailAddress(row.email);

  if (signIn) emails.add(signIn);

  for (const cred of creds) {
    const mailbox = parseEmailAddress(cred.accountLabel);

    if (!mailbox) continue;
    mailboxByAccountId.set(cred.accountId, mailbox);
    emails.add(mailbox);
  }

  const domains = new Set<string>();

  for (const email of emails) {
    const domain = emailDomain(email);

    if (domain && !isFreeMail(domain)) domains.add(domain);
  }

  return { name: row.name, primaryEmail: row.email, mailboxByAccountId, emails, domains };
}
