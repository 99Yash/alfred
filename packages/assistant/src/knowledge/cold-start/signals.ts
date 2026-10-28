import { emailDomain, isFreeMail } from "@alfred/contracts";
import { userIdentity } from "@alfred/assistant/settings";

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

/** Read-only. */
export async function collectColdStartSignals(userId: string): Promise<ColdStartSignals> {
  const { name, primaryEmail, mailboxByAccountId } = await userIdentity({ userId });
  const domain = emailDomain(primaryEmail);
  const integrations: ColdStartSignals["integrations"] = {};

  // A user can have several Google accounts. The oldest active one is the signup account.
  const [signupMailbox] = mailboxByAccountId.values();

  if (signupMailbox) integrations.google = { accountEmail: signupMailbox };

  return {
    userId,
    name,
    email: primaryEmail,
    emailDomain: domain,
    emailDomainIsConsumer: isFreeMail(domain),
    integrations,
  };
}
