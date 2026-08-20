export type {
  CalendarAttendee,
  CalendarEvent,
  CreateEventArgs,
  ListEventsArgs,
  ListEventsResult,
} from "./calendar";
export { createEvent, listEvents } from "./calendar";
export {
  createGoogleClient,
  GoogleCredentialSelectionError,
  googleClientForUser,
  type GoogleAuthority,
  type GoogleClient,
  type GoogleCredential,
  type GoogleTokenResolver,
} from "./client";
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
  GetAttachmentArgs,
  GetAttachmentResult,
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
export type { GoogleService } from "./http";
export {
  batchModifyMessages,
  createLabel,
  extractAttachments,
  extractMessageContent,
  extractMessageHtml,
  getAttachment,
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
export {
  assertGmailPushOidcConfigured,
  GmailPushOidcConfigError,
  isGmailPushOidcConfigError,
  pubSubOidcConfigFromEnv,
} from "./gmail-push-config";
export type { PubSubOidcConfig } from "./gmail-push-config";
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
export { GOOGLE_PASSTHROUGH_BASE_URLS, googlePassthroughProfile } from "./passthrough";
export { featuresFromGrantedScopes, MissingScopesError, requireScopes } from "./scopes";
export { isSelfAuthored, selfSenderEmail } from "./self-mail";
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
export {
  findCredentialByEmail,
  findExpiringGmailWatches,
  gmailWatchStateSchema,
  getGmailWatchState,
  readGmailWatchState,
  stopGmailWatchWithAccessToken,
  uninstallGmailWatch,
  type GmailWatchState,
} from "./watch";
