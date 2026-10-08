import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import type { SelfIdentity } from "./fact-policy";

/**
 * The {@link SelfIdentity} for the Tier B authorship gate (#330): `user.email`
 * plus each active connected account. A missing provider identity fails
 * attribution, never passes it. Shared with the purge script.
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
