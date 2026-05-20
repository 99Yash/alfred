export {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getGoogleOAuthConfig,
  DEFAULT_GOOGLE_SCOPES,
  GOOGLE_FEATURE_SCOPES,
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
  listLabels,
  createLabel,
  modifyMessageLabels,
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
  GmailLabel,
  CreateLabelArgs,
  ModifyMessageLabelsArgs,
} from "./gmail";
export {
  ensureAlfredLabels,
  applyTriageLabel,
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
