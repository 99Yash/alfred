import type { ProviderBindOptions } from "../shared/provider";
import { restPassthroughCapability } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";
import { createEvent, listEvents, type CreateEventArgs, type ListEventsArgs } from "./calendar";
import { getFreshAccessToken, listCredentials, type CredentialRow } from "./credentials";
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
import {
  getMessage,
  listMessages,
  sendMessage,
  type GetMessageArgs,
  type GmailMessage,
  type ListMessagesResult,
  type ListMessagesArgs,
  type SendMessageResult,
  type SendMessageArgs,
} from "./gmail";
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
import type { GoogleService } from "./http";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DOCS_SCOPE,
  DRIVE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
} from "./oauth";

type WithCredentialId<T extends { accessToken: string }> = Omit<T, "accessToken"> & {
  credentialId: string;
};

export interface GoogleTokenResolver {
  (credentialId: string, authority: GoogleAuthority): Promise<string>;
}

export type GoogleAuthority =
  | "gmail_read"
  | "gmail_send"
  | "calendar_read"
  | "calendar_write"
  | "docs"
  | "drive"
  | "sheets"
  | "slides";

const AUTHORITY_SCOPES = {
  gmail_read: [GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE],
  gmail_send: [GMAIL_SEND_SCOPE],
  calendar_read: [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE],
  calendar_write: [CALENDAR_EVENTS_SCOPE],
  docs: [DOCS_SCOPE],
  drive: [DRIVE_SCOPE],
  sheets: [SHEETS_SCOPE],
  slides: [SLIDES_SCOPE],
} satisfies Record<GoogleAuthority, readonly string[]>;

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

function hasAuthority(credential: CredentialRow, authority: GoogleAuthority): boolean {
  const granted = new Set(credential.scopes);
  return AUTHORITY_SCOPES[authority].some((scope) => granted.has(scope));
}

async function credentialsForAuthority(
  userId: string,
  authority: GoogleAuthority,
  accountRef?: string,
): Promise<GoogleCredential[]> {
  const active = (await listCredentials(userId, "google")).filter(
    (credential) => credential.status === "active",
  );
  if (active.length === 0) {
    throw new GoogleCredentialSelectionError(authority, "connection_required");
  }
  const scoped = active.filter(
    (credential) =>
      hasAuthority(credential, authority) &&
      (accountRef === undefined || credential.accountId === accountRef),
  );
  if (scoped.length === 0) {
    throw new GoogleCredentialSelectionError(authority, "scope_required");
  }
  return scoped.map(({ id, accountId, accountLabel }) => ({ id, accountId, accountLabel }));
}

/**
 * Configured Google APIs over a fresh-token resolver. A method still names the
 * selected credential because a user may connect several Google accounts, but
 * the access token is resolved and consumed entirely inside this package.
 */
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

  const passthrough = (service: GoogleService, authority: GoogleAuthority, credentialId: string) =>
    restPassthroughCapability({
      slug: service,
      retry,
      resolveProfile: async () =>
        googlePassthroughProfile(service, await tokenFor(credentialId, authority)),
    });

  return {
    gmail: {
      listMessages: ({
        credentialId,
        ...args
      }: WithCredentialId<ListMessagesArgs>): Promise<ListMessagesResult> =>
        withToken("gmail_read", credentialId, args, listMessages),
      getMessage: ({
        credentialId,
        ...args
      }: WithCredentialId<GetMessageArgs>): Promise<GmailMessage> =>
        withToken("gmail_read", credentialId, args, getMessage),
      sendMessage: ({
        credentialId,
        ...args
      }: WithCredentialId<SendMessageArgs>): Promise<SendMessageResult> =>
        withToken("gmail_send", credentialId, args, sendMessage),
      passthrough: (credentialId: string) => passthrough("gmail", "gmail_read", credentialId),
    },
    calendar: {
      listEvents: ({ credentialId, ...args }: WithCredentialId<ListEventsArgs>) =>
        withToken("calendar_read", credentialId, args, listEvents),
      createEvent: ({ credentialId, ...args }: WithCredentialId<CreateEventArgs>) =>
        withToken("calendar_write", credentialId, args, createEvent),
      passthrough: (credentialId: string) => passthrough("calendar", "calendar_read", credentialId),
    },
    docs: {
      getDocument: ({ credentialId, ...args }: WithCredentialId<GetDocumentArgs>) =>
        withToken("docs", credentialId, args, getDocument),
      passthrough: (credentialId: string) => passthrough("docs", "docs", credentialId),
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
      passthrough: (credentialId: string) => passthrough("drive", "drive", credentialId),
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
      passthrough: (credentialId: string) => passthrough("sheets", "sheets", credentialId),
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
      passthrough: (credentialId: string) => passthrough("slides", "slides", credentialId),
    },
  };
}

/**
 * Google APIs bound to one Alfred user. Ownership is revalidated on every
 * request before the fresh-token boundary accepts a credential id.
 */
export function googleClientForUser(options: ProviderBindOptions) {
  const client = createGoogleClient(async (credentialId, authority) => {
    const owned = (await listCredentials(options.userId, "google")).some(
      (credential) =>
        credential.id === credentialId &&
        credential.status === "active" &&
        hasAuthority(credential, authority),
    );
    if (!owned) throw new GoogleCredentialSelectionError(authority, "scope_required");
    return getFreshAccessToken(credentialId);
  }, options.retry);
  const first = async (authority: GoogleAuthority) =>
    (await credentialsForAuthority(options.userId, authority, options.accountRef))[0]!;
  return {
    ...client,
    gmail: {
      ...client.gmail,
      readCredential: () => first("gmail_read"),
      sendCredential: () => first("gmail_send"),
    },
    calendar: {
      ...client.calendar,
      readCredentials: () =>
        credentialsForAuthority(options.userId, "calendar_read", options.accountRef),
      writeCredential: () => first("calendar_write"),
    },
    docs: { ...client.docs, credential: () => first("docs") },
    drive: { ...client.drive, credential: () => first("drive") },
    sheets: { ...client.sheets, credential: () => first("sheets") },
    slides: { ...client.slides, credential: () => first("slides") },
  };
}

export type GoogleClient = ReturnType<typeof googleClientForUser>;
