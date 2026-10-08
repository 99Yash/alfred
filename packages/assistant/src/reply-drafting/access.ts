import { GOOGLE_SCOPE, holdsAnyScope, type ReplyNoAccessReason } from "@alfred/contracts";
import { listCredentials } from "@alfred/integrations/google";

/**
 * Can Alfred send from this mailbox (ADR-0098)? `no_access` is a decision, not an error:
 * Gmail is read-only or not connected, so no draft is composed.
 */
export type GmailSendAccess =
  | { ok: true; credentialId: string; mailboxAddress: string | null }
  | { ok: false; reason: ReplyNoAccessReason };

export async function checkGmailSendAccess(args: {
  userId: string;
  /** `integration_credentials.account_id` of the receiving mailbox. */
  accountId: string;
}): Promise<GmailSendAccess> {
  const active = (await listCredentials(args.userId, "google")).filter(
    (row) => row.status === "active",
  );

  if (active.length === 0) return { ok: false, reason: "gmail_not_connected" };
  const mailbox = active.find((row) => row.accountId === args.accountId);

  if (!mailbox) return { ok: false, reason: "gmail_not_connected" };

  if (!holdsAnyScope(mailbox.scopes, [GOOGLE_SCOPE.gmail.send])) {
    return { ok: false, reason: "gmail_send_scope_missing" };
  }

  return { ok: true, credentialId: mailbox.id, mailboxAddress: mailbox.accountLabel };
}
