export {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getGoogleOAuthConfig,
  DEFAULT_GOOGLE_SCOPES,
} from "./oauth";
export type { GoogleOAuthConfig, ExchangeCodeResult, RefreshTokenResult } from "./oauth";
export {
  upsertCredential,
  listCredentials,
  getFreshAccessToken,
} from "./credentials";
export type { CredentialRow } from "./credentials";
export {
  ingestRecentGmail,
  listGoogleCredentials,
  pollGmailHistory,
  findCredentialsNeedingPoll,
} from "./ingestor";
export type {
  IngestRecentArgs,
  IngestRecentResult,
  PollHistoryArgs,
  PollHistoryResult,
} from "./ingestor";
export {
  installGmailWatch,
  uninstallGmailWatch,
  getGmailWatchState,
  findCredentialByEmail,
  findExpiringGmailWatches,
} from "./watch";
export type { GmailWatchState } from "./watch";
export {
  listMessages,
  getMessage,
  extractMessageContent,
  listHistory,
  isHistoryGoneError,
  startWatch,
  stopWatch,
} from "./gmail";
export type {
  GmailMessage,
  GmailMessageRef,
  ExtractedMessage,
  GmailHistoryEntry,
  ListHistoryArgs,
  ListHistoryResult,
  StartWatchArgs,
  StartWatchResult,
} from "./gmail";
