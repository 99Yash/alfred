import type { RestPassthroughProfile } from "../shared/rest-passthrough";
import type { ProviderBindOptions } from "../shared/provider";
import { createEvent, listEvents, type CreateEventArgs, type ListEventsArgs } from "./calendar";
import { getFreshAccessToken, listCredentials } from "./credentials";
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

type WithCredentialId<T extends { accessToken: string }> = Omit<T, "accessToken"> & {
  credentialId: string;
};

export interface GoogleTokenResolver {
  (credentialId: string): Promise<string>;
}

/**
 * Configured Google APIs over a fresh-token resolver. A method still names the
 * selected credential because a user may connect several Google accounts, but
 * the access token is resolved and consumed entirely inside this package.
 */
export function createGoogleClient(tokenFor: GoogleTokenResolver) {
  async function withToken<TArgs extends object, TResult>(
    credentialId: string,
    args: TArgs,
    call: (bound: TArgs & { accessToken: string }) => Promise<TResult>,
  ): Promise<TResult> {
    const accessToken = await tokenFor(credentialId);
    return call({ ...args, accessToken });
  }

  const passthroughProfile = async (
    service: GoogleService,
    credentialId: string,
  ): Promise<RestPassthroughProfile> =>
    googlePassthroughProfile(service, await tokenFor(credentialId));

  return {
    gmail: {
      listMessages: ({
        credentialId,
        ...args
      }: WithCredentialId<ListMessagesArgs>): Promise<ListMessagesResult> =>
        withToken(credentialId, args, listMessages),
      getMessage: ({
        credentialId,
        ...args
      }: WithCredentialId<GetMessageArgs>): Promise<GmailMessage> =>
        withToken(credentialId, args, getMessage),
      sendMessage: ({
        credentialId,
        ...args
      }: WithCredentialId<SendMessageArgs>): Promise<SendMessageResult> =>
        withToken(credentialId, args, sendMessage),
      passthroughProfile: (credentialId: string) => passthroughProfile("gmail", credentialId),
    },
    calendar: {
      listEvents: ({ credentialId, ...args }: WithCredentialId<ListEventsArgs>) =>
        withToken(credentialId, args, listEvents),
      createEvent: ({ credentialId, ...args }: WithCredentialId<CreateEventArgs>) =>
        withToken(credentialId, args, createEvent),
      passthroughProfile: (credentialId: string) => passthroughProfile("calendar", credentialId),
    },
    docs: {
      getDocument: ({ credentialId, ...args }: WithCredentialId<GetDocumentArgs>) =>
        withToken(credentialId, args, getDocument),
      passthroughProfile: (credentialId: string) => passthroughProfile("docs", credentialId),
    },
    drive: {
      listFiles: ({ credentialId, ...args }: WithCredentialId<ListFilesArgs>) =>
        withToken(credentialId, args, listFiles),
      getFile: ({ credentialId, ...args }: WithCredentialId<GetFileArgs>) =>
        withToken(credentialId, args, getFile),
      exportFile: ({ credentialId, ...args }: WithCredentialId<ExportFileArgs>) =>
        withToken(credentialId, args, exportFile),
      downloadFile: ({ credentialId, ...args }: WithCredentialId<DownloadFileArgs>) =>
        withToken(credentialId, args, downloadFile),
      passthroughProfile: (credentialId: string) => passthroughProfile("drive", credentialId),
    },
    sheets: {
      createSpreadsheet: ({ credentialId, ...args }: WithCredentialId<CreateSpreadsheetArgs>) =>
        withToken(credentialId, args, createSpreadsheet),
      getValues: ({ credentialId, ...args }: WithCredentialId<GetValuesArgs>) =>
        withToken(credentialId, args, getValues),
      updateValues: ({ credentialId, ...args }: WithCredentialId<UpdateValuesArgs>) =>
        withToken(credentialId, args, updateValues),
      appendValues: ({ credentialId, ...args }: WithCredentialId<AppendValuesArgs>) =>
        withToken(credentialId, args, appendValues),
      batchUpdateSpreadsheet: ({
        credentialId,
        ...args
      }: WithCredentialId<BatchUpdateSpreadsheetArgs>) =>
        withToken(credentialId, args, batchUpdateSpreadsheet),
      addSheet: (args: { credentialId: string; spreadsheetId: string; title: string }) => {
        const { credentialId, ...rest } = args;
        return tokenFor(credentialId).then((accessToken) => addSheet({ accessToken, ...rest }));
      },
      passthroughProfile: (credentialId: string) => passthroughProfile("sheets", credentialId),
    },
    slides: {
      createPresentation: ({ credentialId, ...args }: WithCredentialId<CreatePresentationArgs>) =>
        withToken(credentialId, args, createPresentation),
      getPresentation: ({ credentialId, ...args }: WithCredentialId<GetPresentationArgs>) =>
        withToken(credentialId, args, getPresentation),
      batchUpdatePresentation: ({
        credentialId,
        ...args
      }: WithCredentialId<BatchUpdatePresentationArgs>) =>
        withToken(credentialId, args, batchUpdatePresentation),
      addSlide: (args: {
        credentialId: string;
        presentationId: string;
        layout?: string | undefined;
      }) => {
        const { credentialId, ...rest } = args;
        return tokenFor(credentialId).then((accessToken) => addSlide({ accessToken, ...rest }));
      },
      passthroughProfile: (credentialId: string) => passthroughProfile("slides", credentialId),
    },
  };
}

/**
 * Google APIs bound to one Alfred user. Ownership is revalidated on every
 * request before the fresh-token boundary accepts a credential id.
 */
export function googleClientForUser(options: ProviderBindOptions) {
  return createGoogleClient(async (credentialId) => {
    const owned = (await listCredentials(options.userId, "google")).some(
      (credential) => credential.id === credentialId && credential.status === "active",
    );
    if (!owned) throw new Error("[google.credentials] active credential not found for user");
    return getFreshAccessToken(credentialId);
  });
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
