export type { CalendarAttendee, CalendarEvent, ListEventsArgs, ListEventsResult } from "./calendar";
export { listEvents } from "./calendar";
export type { CredentialRow } from "./credentials";
export { getFreshAccessToken, listCredentials, upsertCredential } from "./credentials";
export type { DocumentHeading, GetDocumentArgs, GetDocumentResult } from "./docs";
export { getDocument } from "./docs";
export type {
  DownloadFileArgs,
  DriveFile,
  ExportFileArgs,
  FileContentResult,
  GetFileArgs,
  ListFilesArgs,
  ListFilesResult,
} from "./drive";
export { downloadFile, exportFile, getFile, listFiles } from "./drive";
export type {
  BatchModifyMessagesArgs,
  CreateLabelArgs,
  ExtractedAttachment,
  ExtractedMessage,
  GmailHistoryEntry,
  GmailLabel,
  GmailMessage,
  GmailMessageRef,
  ListHistoryArgs,
  ListHistoryResult,
  ModifyMessageLabelsArgs,
  SendMessageArgs,
  SendMessageResult,
  StartWatchArgs,
  StartWatchResult,
} from "./gmail";
export {
  batchModifyMessages,
  createLabel,
  extractAttachments,
  extractMessageContent,
  extractMessageHtml,
  getMessage,
  getThreadMessageLabels,
  isHistoryGoneError,
  listHistory,
  listLabels,
  listMessages,
  modifyMessageLabels,
  sendMessage,
  startWatch,
  stopWatch,
} from "./gmail";
export type {
  IngestRecentArgs,
  IngestRecentResult,
  PollHistoryArgs,
  PollHistoryResult,
  PollRecentArgs,
  PollRecentResult,
} from "./ingestor";
export {
  findCredentialsNeedingPoll,
  ingestRecentGmail,
  listGoogleCredentials,
  pollGmailHistory,
  pollGmailRecent,
} from "./ingestor";
export type {
  AlfredLabelMap,
  ApplyTriageLabelArgs,
  ApplyTriageLabelResult,
  TriageCategory,
} from "./labels";
export {
  applyTriageLabel,
  categoryFromLabelName,
  ensureAlfredLabels,
  findThreadSiblingsWithAlfredLabels,
  labelNameFor,
  TRIAGE_CATEGORIES,
} from "./labels";
export type {
  ExchangeCodeResult,
  GoogleFeature,
  GoogleOAuthConfig,
  RefreshTokenResult,
} from "./oauth";
export {
  ALL_GOOGLE_SCOPES,
  buildAuthorizeUrl,
  CALENDAR_READONLY_SCOPE,
  DEFAULT_GOOGLE_SCOPES,
  DOCS_READONLY_SCOPE,
  DRIVE_READONLY_SCOPE,
  exchangeCode,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_FEATURE_SCOPES,
  getGoogleOAuthConfig,
  isRestrictedFeature,
  PUBLIC_FEATURES,
  PUBLIC_GOOGLE_SCOPES,
  RESTRICTED_FEATURES,
  RESTRICTED_SCOPES,
  refreshAccessToken,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
  scopesForFeatures,
} from "./oauth";
export { featuresFromGrantedScopes, MissingScopesError, requireScopes } from "./scopes";
export type {
  AppendValuesArgs,
  AppendValuesResult,
  BatchUpdateSpreadsheetArgs,
  BatchUpdateSpreadsheetResult,
  CellValue,
  CreateSpreadsheetArgs,
  CreateSpreadsheetResult,
  GetValuesArgs,
  GetValuesResult,
  UpdateValuesArgs,
  UpdateValuesResult,
  ValueInputOption,
} from "./sheets";
export {
  addSheet,
  appendValues,
  batchUpdateSpreadsheet,
  createSpreadsheet,
  getValues,
  updateValues,
} from "./sheets";
export type {
  BatchUpdatePresentationArgs,
  BatchUpdatePresentationResult,
  CreatePresentationArgs,
  CreatePresentationResult,
  GetPresentationArgs,
  GetPresentationResult,
} from "./slides";
export { addSlide, batchUpdatePresentation, createPresentation, getPresentation } from "./slides";
export type { GmailWatchState } from "./watch";
export {
  findCredentialByEmail,
  findExpiringGmailWatches,
  getGmailWatchState,
  installGmailWatch,
  uninstallGmailWatch,
} from "./watch";
