export {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getGoogleOAuthConfig,
  DEFAULT_GOOGLE_SCOPES,
  GOOGLE_FEATURE_SCOPES,
  GMAIL_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DRIVE_READONLY_SCOPE,
  DOCS_READONLY_SCOPE,
  SHEETS_READONLY_SCOPE,
  SLIDES_READONLY_SCOPE,
  scopesForFeatures,
} from "./oauth";
export type {
  GoogleOAuthConfig,
  ExchangeCodeResult,
  RefreshTokenResult,
  GoogleFeature,
} from "./oauth";
export { requireScopes, featuresFromGrantedScopes, MissingScopesError } from "./scopes";
export { upsertCredential, listCredentials, getFreshAccessToken } from "./credentials";
export type { CredentialRow } from "./credentials";
export {
  ingestRecentGmail,
  listGoogleCredentials,
  pollGmailHistory,
  pollGmailRecent,
  findCredentialsNeedingPoll,
} from "./ingestor";
export type {
  IngestRecentArgs,
  IngestRecentResult,
  PollHistoryArgs,
  PollHistoryResult,
  PollRecentArgs,
  PollRecentResult,
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
  getThreadMessageLabels,
  extractMessageContent,
  extractMessageHtml,
  extractAttachments,
  listHistory,
  isHistoryGoneError,
  startWatch,
  stopWatch,
  listLabels,
  createLabel,
  modifyMessageLabels,
  batchModifyMessages,
} from "./gmail";
export type {
  GmailMessage,
  GmailMessageRef,
  ExtractedMessage,
  ExtractedAttachment,
  GmailHistoryEntry,
  ListHistoryArgs,
  ListHistoryResult,
  StartWatchArgs,
  StartWatchResult,
  GmailLabel,
  CreateLabelArgs,
  ModifyMessageLabelsArgs,
  BatchModifyMessagesArgs,
} from "./gmail";
export { listEvents } from "./calendar";
export type { CalendarEvent, CalendarAttendee, ListEventsArgs, ListEventsResult } from "./calendar";
export {
  ensureAlfredLabels,
  applyTriageLabel,
  findThreadSiblingsWithAlfredLabels,
  labelNameFor,
  categoryFromLabelName,
  TRIAGE_CATEGORIES,
} from "./labels";
export type {
  TriageCategory,
  AlfredLabelMap,
  ApplyTriageLabelArgs,
  ApplyTriageLabelResult,
} from "./labels";
