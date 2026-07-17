export type {
  CalendarAttendee,
  CalendarEvent,
  CreateEventArgs,
  ListEventsArgs,
  ListEventsResult,
} from "./calendar";
export { createEvent, listEvents } from "./calendar";
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
  isSelfAuthored,
  listGoogleCredentials,
  pollGmailHistory,
  pollGmailRecent,
  selfSenderEmail,
} from "./ingestor";
export type {
  AlfredLabelMap,
  ApplyTriageLabelArgs,
  ApplyTriageLabelResult,
  LabelSelfAuthoredMailArgs,
  LabelSelfMailDeps,
  TriageCategory,
} from "./labels";
export {
  ALFRED_SELF_LABEL_NAME,
  applyTriageLabel,
  categoryFromLabelName,
  ensureAlfredLabels,
  ensureAlfredSelfLabel,
  findThreadSiblingsWithAlfredLabels,
  labelNameFor,
  labelSelfAuthoredMail,
  TRIAGE_CATEGORIES,
} from "./labels";
export type {
  AccountPersona,
  ExchangeCodeResult,
  GoogleFeature,
  GoogleOAuthConfig,
  RefreshTokenResult,
} from "./oauth";
export {
  ALL_GOOGLE_SCOPES,
  buildAuthorizeUrl,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DEFAULT_GOOGLE_SCOPES,
  detectPersona,
  DOCS_SCOPE,
  DRIVE_SCOPE,
  exchangeCode,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_FEATURE_SCOPES,
  getGoogleOAuthConfig,
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
  stopGmailWatchWithAccessToken,
  uninstallGmailWatch,
} from "./watch";
