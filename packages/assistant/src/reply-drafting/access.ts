import { assertNever, type ReplyNoAccessReason } from "@alfred/contracts";
import { integrations } from "@alfred/integrations";
import { GoogleCredentialSelectionError } from "@alfred/integrations/google";

/**
 * Can Alfred write a Gmail draft in this mailbox (ADR-0098, amended 2026-11-15)?
 * `no_access` is a decision, not an error: Gmail is not connected, or no account holds
 * the `gmail.modify` grant that `drafts.create` needs, so no draft is composed.
 */
export type GmailDraftAccess =
  | { ok: true; credentialId: string; mailboxAddress: string | null }
  | { ok: false; reason: ReplyNoAccessReason };

export async function checkGmailDraftAccess(args: {
  userId: string;
  /** `integration_credentials.account_id` of the receiving mailbox. */
  accountId: string;
}): Promise<GmailDraftAccess> {
  try {
    const mailbox = await integrations({
      userId: args.userId,
      accountRef: args.accountId,
      retry: "none",
    }).google.gmail.modifyCredential();

    return { ok: true, credentialId: mailbox.id, mailboxAddress: mailbox.accountLabel };
  } catch (err) {
    if (!(err instanceof GoogleCredentialSelectionError)) throw err;

    switch (err.reason) {
      case "connection_required":
        return { ok: false, reason: "gmail_not_connected" };
      case "scope_required":
        return { ok: false, reason: "gmail_send_scope_missing" };
      default:
        return assertNever(err.reason, "GoogleCredentialSelectionError reason");
    }
  }
}
