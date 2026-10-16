import type { RetryPolicy } from "../shared/retry";
import { getFreshAccessToken } from "./credentials";
import {
  batchModifyMessages,
  createLabel,
  getAttachment,
  getMessage,
  getThreadMessageLabels,
  listHistory,
  listLabels,
  listMessages,
  modifyMessageLabels,
  sendMessage,
  startWatch,
  stopWatch,
  type BatchModifyMessagesArgs,
  type CreateLabelArgs,
  type GetAttachmentArgs,
  type GetMessageArgs,
  type GmailMessage,
  type ListHistoryArgs,
  type ListMessagesArgs,
  type ModifyMessageLabelsArgs,
  type SendMessageArgs,
  type StartWatchArgs,
} from "./gmail";

type Unbound<T extends { accessToken: string }> = Omit<T, "accessToken">;

/**
 * The one place a Google access token meets a Gmail call. Every method asks `accessToken` for a
 * token immediately before its request and never keeps it, so a mailbox lives as long as you like
 * and cannot go stale.
 *
 * Package-internal: the user-bound client passes an owner-checked resolver, and the
 * post-delete watch stop passes the token it resolved before the credential row went away.
 * Application code calls {@link gmailMailbox}.
 */
export function gmailMailboxFor(
  accessToken: () => Promise<string>,
  retry: RetryPolicy | "none" = "none",
) {
  return {
    /** One `messages.list` page. Callers paginate with `pageToken`. */
    listMessages: async (args: Unbound<ListMessagesArgs>) =>
      listMessages({ ...args, accessToken: await accessToken() }, retry),
    getMessage: async (args: Unbound<GetMessageArgs>): Promise<GmailMessage> =>
      getMessage({ ...args, accessToken: await accessToken() }, retry),
    /** `threads.get` in `minimal` format: message ids and labels only. */
    getThreadMessageLabels: async (args: { threadId: string }) =>
      getThreadMessageLabels({ ...args, accessToken: await accessToken() }),
    /** One `history.list` page. A stale cursor throws an error `isHistoryGoneError` matches. */
    listHistory: async (args: Unbound<ListHistoryArgs>) =>
      listHistory({ ...args, accessToken: await accessToken() }),
    startWatch: async (args: Unbound<StartWatchArgs>) =>
      startWatch({ ...args, accessToken: await accessToken() }),
    stopWatch: async () => stopWatch({ accessToken: await accessToken() }),
    listLabels: async () => listLabels({ accessToken: await accessToken() }),
    createLabel: async (args: Unbound<CreateLabelArgs>) =>
      createLabel({ ...args, accessToken: await accessToken() }),
    modifyMessageLabels: async (args: Unbound<ModifyMessageLabelsArgs>): Promise<GmailMessage> =>
      modifyMessageLabels({ ...args, accessToken: await accessToken() }),
    batchModifyMessages: async (args: Unbound<BatchModifyMessagesArgs>) =>
      batchModifyMessages({ ...args, accessToken: await accessToken() }),
    sendMessage: async (args: Unbound<SendMessageArgs>) =>
      sendMessage({ ...args, accessToken: await accessToken() }),
    getAttachment: async (args: Unbound<GetAttachmentArgs>) =>
      getAttachment({ ...args, accessToken: await accessToken() }, retry),
  };
}

/** One connected Gmail account's mailbox. Methods mirror the Gmail REST calls. */
export type GmailMailbox = ReturnType<typeof gmailMailboxFor>;

/**
 * The mailbox of one Google credential, for code that already holds a trusted credential id
 * (ingestion, triage, the inbox routes, scripts). A user can connect several Google accounts, so
 * the credential, not the user, names the mailbox.
 *
 * Each call resolves its token through `getFreshAccessToken`: an unexpired token is one primary-key
 * read, a near-expiry token refreshes under the row lock, and a revoked grant marks the credential
 * `needs_reauth` and throws. This does NOT check that a user owns the credential or holds a scope;
 * tools reach Gmail through `integrations({ userId }).google.gmail`, which does. Mailbox writes
 * are not gated here either: gate them with `gmailMailboxWritesEnabled()` at the semantic write
 * site (ADR-0081).
 */
export function gmailMailbox(options: { credentialId: string }): GmailMailbox {
  return gmailMailboxFor(() => getFreshAccessToken(options.credentialId));
}
