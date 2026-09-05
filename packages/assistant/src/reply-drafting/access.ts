import { GOOGLE_SCOPE, holdsAnyScope, type ReplyNoAccessReason } from "@alfred/contracts";
import { listCredentials } from "@alfred/integrations/google";

/**
 * Whether Alfred could send from the mailbox at all (ADR-0098). A `no_access`
 * outcome is a decision, not an error: the user connected Gmail read-only, or
 * never connected it, and the run records that instead of composing a draft
 * that no approval could ever send.
 */
export type GmailSendAccess =
  | { ok: true; credentialId: string }
  | { ok: false; reason: ReplyNoAccessReason };

export async function checkGmailSendAccess(args: {
  userId: string;
  /** The `integration_credentials.account_id` of the mailbox the inbound mail arrived in. */
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
  return { ok: true, credentialId: mailbox.id };
}
