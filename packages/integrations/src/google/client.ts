import type { ProviderBindOptions } from "../shared/provider";
import { restPassthroughCapability } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  respondToEvent,
  updateEvent,
  type CreateEventArgs,
  type DeleteEventArgs,
  type EventRefArgs,
  type ListEventsArgs,
  type RespondToEventArgs,
  type UpdateEventArgs,
} from "./calendar";
import { getOwnedFreshAccessToken, listCredentials, type CredentialRow } from "./credentials";
import { getDocument, type GetDocumentArgs } from "./docs";
import {
  downloadFile,
  exportFile,
  getFile,
  listFiles,
  type DownloadFileArgs,
  type ExportFileArgs,
  type GetFileArgs,
  type ListFilesArgs,
} from "./drive";
import type {
  CreateDraftResult,
  CreateLabelArgs,
  GetMessageArgs,
  GetThreadArgs,
  GmailLabel,
  GmailMessage,
  GmailThread,
  ListMessagesResult,
  ListMessagesArgs,
  ModifyMessageLabelsArgs,
  ModifyThreadLabelsArgs,
  DraftMessageArgs,
  DraftRefArgs,
  SentMessage,
} from "./gmail";
import { gmailMailboxFor } from "./mailbox";
import { googlePassthroughProfile } from "./passthrough";
import {
  addSheet,
  appendValues,
  batchUpdateSpreadsheet,
  createSpreadsheet,
  getValues,
  updateValues,
  type AppendValuesArgs,
  type BatchUpdateSpreadsheetArgs,
  type CreateSpreadsheetArgs,
  type GetValuesArgs,
  type UpdateValuesArgs,
} from "./sheets";
import {
  addSlide,
  batchUpdatePresentation,
  createPresentation,
  getPresentation,
  type BatchUpdatePresentationArgs,
  type CreatePresentationArgs,
  type GetPresentationArgs,
} from "./slides";
import {
  getContact,
  listContacts,
  searchContacts,
  type GetContactArgs,
  type ListContactsArgs,
  type SearchContactsArgs,
} from "./contacts";
import type { GoogleService } from "./http";
import { googleAuthorityScopes, holdsAnyScope, type GoogleAuthority } from "@alfred/contracts";

type WithCredentialId<T extends { accessToken: string }> = Omit<T, "accessToken"> & {
  credentialId: string;
};

export interface GoogleTokenResolver {
  (credentialId: string, authority: GoogleAuthority): Promise<string>;
}

export type GoogleCredential = Pick<CredentialRow, "id" | "accountId" | "accountLabel">;

export class GoogleCredentialSelectionError extends Error {
  readonly _tag = "GoogleCredentialSelectionError" as const;
  constructor(
    readonly authority: GoogleAuthority,
    readonly reason: "connection_required" | "scope_required",
  ) {
    super(`[google.credentials] ${authority}: ${reason}`);
    this.name = "GoogleCredentialSelectionError";
  }
}

async function credentialsForAuthority(
  userId: string,
  authority: GoogleAuthority,
  accountRef?: string,
): Promise<GoogleCredential[]> {
  return credentialsHoldingAll(userId, [authority], accountRef);
}

/** The active rows that hold every authority. One row must hold them all, not the set of rows. */
async function credentialsHoldingAll(
  userId: string,
  authorities: readonly [GoogleAuthority, ...GoogleAuthority[]],
  accountRef?: string,
): Promise<GoogleCredential[]> {
  // A pinned account that is gone is "not connected", not "missing a scope".
  const active = (await listCredentials(userId, "google")).filter(
    (credential) =>
      credential.status === "active" &&
      (accountRef === undefined || credential.accountId === accountRef),
  );

  if (active.length === 0) {
    throw new GoogleCredentialSelectionError(authorities[0], "connection_required");
  }

  const holdsAll = (scopes: Iterable<string>) => {
    const granted = [...scopes];

    return authorities.every((authority) =>
      holdsAnyScope(granted, googleAuthorityScopes(authority)),
    );
  };

  const scoped = active.filter((credential) => holdsAll(credential.scopes));

  if (scoped.length === 0) {
    // Name the first grant that the first account lacks, so the error says what to grant.
    const firstScopes = [...(active[0]?.scopes ?? [])];

    const missing =
      authorities.find(
        (authority) => !holdsAnyScope(firstScopes, googleAuthorityScopes(authority)),
      ) ?? authorities[0];

    throw new GoogleCredentialSelectionError(missing, "scope_required");
  }

  return scoped.map(({ id, accountId, accountLabel }) => ({ id, accountId, accountLabel }));
}

/** Methods take a credential id because a user can connect several Google accounts. */
export function createGoogleClient(
  tokenFor: GoogleTokenResolver,
  retry: RetryPolicy | "none" = "none",
) {
  async function withToken<TArgs extends object, TResult>(
    authority: GoogleAuthority,
    credentialId: string,
    args: TArgs,
    call: (
      bound: TArgs & { accessToken: string },
      retry?: RetryPolicy | "none",
    ) => Promise<TResult>,
  ): Promise<TResult> {
    const accessToken = await tokenFor(credentialId, authority);

    return call({ ...args, accessToken }, retry);
  }

  // A passthrough is a read, and the read authority of a service is its slug.
  const passthrough = (service: GoogleService, credentialId: string) =>
    restPassthroughCapability({
      slug: service,
      retry,
      resolveProfile: async () =>
        googlePassthroughProfile(service, await tokenFor(credentialId, service)),
    });

  // The same mailbox `gmailMailbox` returns, behind this client's owner-checked resolver.
  const mailbox = (credentialId: string, authority: GoogleAuthority) =>
    gmailMailboxFor(() => tokenFor(credentialId, authority), retry);

  return {
    gmail: {
      listMessages: ({
        credentialId,
        ...args
      }: WithCredentialId<ListMessagesArgs>): Promise<ListMessagesResult> =>
        mailbox(credentialId, "gmail").listMessages(args),
      getMessage: ({
        credentialId,
        ...args
      }: WithCredentialId<GetMessageArgs>): Promise<GmailMessage> =>
        mailbox(credentialId, "gmail").getMessage(args),
      getThread: ({
        credentialId,
        ...args
      }: WithCredentialId<GetThreadArgs>): Promise<GmailThread> =>
        mailbox(credentialId, "gmail").getThread(args),
      listLabels: (credentialId: string): Promise<GmailLabel[]> =>
        mailbox(credentialId, "gmail").listLabels(),
      createLabel: ({
        credentialId,
        ...args
      }: WithCredentialId<CreateLabelArgs>): Promise<GmailLabel> =>
        mailbox(credentialId, "gmail_modify").createLabel(args),
      modifyThreadLabels: ({
        credentialId,
        ...args
      }: WithCredentialId<ModifyThreadLabelsArgs>): Promise<GmailThread> =>
        mailbox(credentialId, "gmail_modify").modifyThreadLabels(args),
      modifyMessageLabels: ({
        credentialId,
        ...args
      }: WithCredentialId<ModifyMessageLabelsArgs>): Promise<GmailMessage> =>
        mailbox(credentialId, "gmail_modify").modifyMessageLabels(args),
      createDraft: ({
        credentialId,
        ...args
      }: WithCredentialId<DraftMessageArgs>): Promise<CreateDraftResult> =>
        mailbox(credentialId, "gmail_modify").createDraft(args),
      // `drafts.send` takes `gmail.modify` or `gmail.compose`, not `gmail.send`.
      sendDraft: ({
        credentialId,
        ...args
      }: WithCredentialId<DraftRefArgs>): Promise<SentMessage> =>
        mailbox(credentialId, "gmail_modify").sendDraft(args),
      deleteDraft: ({ credentialId, ...args }: WithCredentialId<DraftRefArgs>): Promise<void> =>
        mailbox(credentialId, "gmail_modify").deleteDraft(args),
      passthrough: (credentialId: string) => passthrough("gmail", credentialId),
    },
    calendar: {
      listEvents: ({ credentialId, ...args }: WithCredentialId<ListEventsArgs>) =>
        withToken("calendar", credentialId, args, listEvents),
      createEvent: ({ credentialId, ...args }: WithCredentialId<CreateEventArgs>) =>
        withToken("calendar_write", credentialId, args, createEvent),
      getEvent: ({ credentialId, ...args }: WithCredentialId<EventRefArgs>) =>
        withToken("calendar", credentialId, args, getEvent),
      updateEvent: ({ credentialId, ...args }: WithCredentialId<UpdateEventArgs>) =>
        withToken("calendar_write", credentialId, args, updateEvent),
      deleteEvent: ({ credentialId, ...args }: WithCredentialId<DeleteEventArgs>) =>
        withToken("calendar_write", credentialId, args, deleteEvent),
      respondToEvent: ({ credentialId, ...args }: WithCredentialId<RespondToEventArgs>) =>
        withToken("calendar_write", credentialId, args, respondToEvent),
      passthrough: (credentialId: string) => passthrough("calendar", credentialId),
    },
    docs: {
      getDocument: ({ credentialId, ...args }: WithCredentialId<GetDocumentArgs>) =>
        withToken("docs", credentialId, args, getDocument),
      passthrough: (credentialId: string) => passthrough("docs", credentialId),
    },
    drive: {
      listFiles: ({ credentialId, ...args }: WithCredentialId<ListFilesArgs>) =>
        withToken("drive", credentialId, args, listFiles),
      getFile: ({ credentialId, ...args }: WithCredentialId<GetFileArgs>) =>
        withToken("drive", credentialId, args, getFile),
      exportFile: ({ credentialId, ...args }: WithCredentialId<ExportFileArgs>) =>
        withToken("drive", credentialId, args, exportFile),
      downloadFile: ({ credentialId, ...args }: WithCredentialId<DownloadFileArgs>) =>
        withToken("drive", credentialId, args, downloadFile),
      passthrough: (credentialId: string) => passthrough("drive", credentialId),
    },
    sheets: {
      createSpreadsheet: ({ credentialId, ...args }: WithCredentialId<CreateSpreadsheetArgs>) =>
        withToken("sheets", credentialId, args, createSpreadsheet),
      getValues: ({ credentialId, ...args }: WithCredentialId<GetValuesArgs>) =>
        withToken("sheets", credentialId, args, getValues),
      updateValues: ({ credentialId, ...args }: WithCredentialId<UpdateValuesArgs>) =>
        withToken("sheets", credentialId, args, updateValues),
      appendValues: ({ credentialId, ...args }: WithCredentialId<AppendValuesArgs>) =>
        withToken("sheets", credentialId, args, appendValues),
      batchUpdateSpreadsheet: ({
        credentialId,
        ...args
      }: WithCredentialId<BatchUpdateSpreadsheetArgs>) =>
        withToken("sheets", credentialId, args, batchUpdateSpreadsheet),
      addSheet: (args: { credentialId: string; spreadsheetId: string; title: string }) => {
        const { credentialId, ...rest } = args;

        return tokenFor(credentialId, "sheets").then((accessToken) =>
          addSheet({ accessToken, ...rest }),
        );
      },
      passthrough: (credentialId: string) => passthrough("sheets", credentialId),
    },
    slides: {
      createPresentation: ({ credentialId, ...args }: WithCredentialId<CreatePresentationArgs>) =>
        withToken("slides", credentialId, args, createPresentation),
      getPresentation: ({ credentialId, ...args }: WithCredentialId<GetPresentationArgs>) =>
        withToken("slides", credentialId, args, getPresentation),
      batchUpdatePresentation: ({
        credentialId,
        ...args
      }: WithCredentialId<BatchUpdatePresentationArgs>) =>
        withToken("slides", credentialId, args, batchUpdatePresentation),
      addSlide: (args: {
        credentialId: string;
        presentationId: string;
        layout?: string | undefined;
      }) => {
        const { credentialId, ...rest } = args;

        return tokenFor(credentialId, "slides").then((accessToken) =>
          addSlide({ accessToken, ...rest }),
        );
      },
      passthrough: (credentialId: string) => passthrough("slides", credentialId),
    },
    contacts: {
      searchContacts: ({ credentialId, ...args }: WithCredentialId<SearchContactsArgs>) =>
        withToken("contacts", credentialId, args, searchContacts),
      listContacts: ({ credentialId, ...args }: WithCredentialId<ListContactsArgs>) =>
        withToken("contacts", credentialId, args, listContacts),
      getContact: ({ credentialId, ...args }: WithCredentialId<GetContactArgs>) =>
        withToken("contacts", credentialId, args, getContact),
    },
  };
}

/** Checks ownership of the credential id on every request. */
export function googleClientForUser(options: ProviderBindOptions) {
  const client = createGoogleClient(async (credentialId, authority) => {
    const accessToken = await getOwnedFreshAccessToken({
      userId: options.userId,
      credentialId,
      anyOfScopes: googleAuthorityScopes(authority),
    });

    if (accessToken === null) throw new GoogleCredentialSelectionError(authority, "scope_required");

    return accessToken;
  }, options.retry);

  const first = async (...authorities: [GoogleAuthority, ...GoogleAuthority[]]) => {
    const [credential] = await credentialsHoldingAll(
      options.userId,
      authorities,
      options.accountRef,
    );

    // credentialsHoldingAll already throws this error for an empty list.
    if (!credential) throw new GoogleCredentialSelectionError(authorities[0], "scope_required");

    return credential;
  };

  return {
    ...client,
    gmail: {
      ...client.gmail,
      readCredential: () => first("gmail"),
      /**
       * An account that can send through a draft: the send grant is the user's consent, and the
       * draft calls need the modify grant. The send grant comes first, so a missing consent
       * names `gmail_send`.
       */
      sendCredential: () => first("gmail_send", "gmail_modify"),
      modifyCredential: () => first("gmail_modify"),
      /** Every account that can change labels. A message picks one by `accountId`. */
      modifyCredentials: () =>
        credentialsForAuthority(options.userId, "gmail_modify", options.accountRef),
    },
    calendar: {
      ...client.calendar,
      readCredentials: () =>
        credentialsForAuthority(options.userId, "calendar", options.accountRef),
      writeCredential: () => first("calendar_write"),
      /** Every account that can write events. An event reference picks one by `accountId`. */
      writeCredentials: () =>
        credentialsForAuthority(options.userId, "calendar_write", options.accountRef),
    },
    docs: { ...client.docs, credential: () => first("docs") },
    drive: { ...client.drive, credential: () => first("drive") },
    sheets: { ...client.sheets, credential: () => first("sheets") },
    slides: { ...client.slides, credential: () => first("slides") },
    contacts: { ...client.contacts, credential: () => first("contacts") },
  };
}

export type GoogleClient = ReturnType<typeof googleClientForUser>;
