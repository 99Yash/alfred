import { assertNever, type ReplyNoAccessReason } from "@alfred/contracts";
import { integrations } from "@alfred/integrations";
import { GoogleCredentialSelectionError } from "@alfred/integrations/google";

/**
 * Can Alfred send from this mailbox (ADR-0098)? `no_access` is a decision, not an error:
 * Gmail is not connected, or no account holds both the send and the modify grant that
 * `gmail.send_draft` needs, so no draft is composed.
 */
export type GmailSendAccess =
  | { ok: true; credentialId: string; mailboxAddress: string | null }
  | { ok: false; reason: ReplyNoAccessReason };

export async function checkGmailSendAccess(args: {
  userId: string;
  /** `integration_credentials.account_id` of the receiving mailbox. */
  accountId: string;
}): Promise<GmailSendAccess> {
  try {
    const mailbox = await integrations({
      userId: args.userId,
      accountRef: args.accountId,
      retry: "none",
    }).google.gmail.sendCredential();

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
