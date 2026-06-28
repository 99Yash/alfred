import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import type { SelfIdentity } from "./fact-policy";

/**
 * Build the {@link SelfIdentity} the Tier-B authorship gate (#330, ADR-0079)
 * matches a document's author against: the global `user.email` plus every
 * active connected account. Gmail credentials carry the mailbox email in
 * `account_label` (keyed by `account_id`, which matches `documents.account_id`);
 * GitHub carries the login in `account_label` and the numeric user id in
 * `account_id`. Conservative by construction — an absent provider identity just
 * means that provider's docs can't pass attribution (never a false positive).
 *
 * Shared by the memory-extraction workflow (live capture) and the #330 purge
 * script (re-judging leaked rows) so authorship has ONE definition.
 */
export async function loadSelfIdentity(userId: string): Promise<SelfIdentity> {
  const [[selfRow], creds] = await Promise.all([
    db().select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1),
    db()
      .select({
        provider: integrationCredentials.provider,
        accountId: integrationCredentials.accountId,
        accountLabel: integrationCredentials.accountLabel,
      })
      .from(integrationCredentials)
      .where(
        and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.status, "active")),
      ),
  ]);

  const emails = new Set<string>();
  const selfEmail = (selfRow?.email ?? "").trim().toLowerCase();
  if (selfEmail) emails.add(selfEmail);
  const gmailAccountEmailById: Record<string, string> = {};
  let github: SelfIdentity["github"];

  for (const c of creds) {
    const label = c.accountLabel?.trim().toLowerCase() || null;
    if (c.provider === "google") {
      if (label) {
        gmailAccountEmailById[c.accountId] = label;
        emails.add(label);
      }
    } else if (c.provider === "github") {
      github = { login: c.accountLabel?.trim() || null, userId: c.accountId };
    }
  }

  return { emails: [...emails], gmailAccountEmailById, ...(github ? { github } : {}) };
}
