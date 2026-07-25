export {
  getGithubAppConfig,
  buildInstallUrl,
  mintAppJwt,
  getInstallationToken,
  exchangeUserCode,
  canUserAccessInstallation,
  verifyWebhookSignature,
} from "./app";
export type { GithubAppConfig, InstallationToken, ExchangeUserCodeResult } from "./app";
export {
  upsertGithubCredential,
  getGithubAccessToken,
  getInstallationTokenForUser,
  listGithubCredentials,
  findUserByInstallationId,
} from "./credentials";
export type {
  UpsertGithubCredentialArgs,
  GithubCredentialSummary,
  UserInstallationToken,
} from "./credentials";
// The ONE door to GitHub's REST API on a user's behalf — the curated reads plus
// the passthrough transport profile. Application code reaches it through
// `ctx.integrations.github`, which binds the user for it; nothing outside
// `client.ts` needs a token to talk to GitHub.
export { createGithubClient, githubClientForUser } from "./client";
export type {
  GithubClient,
  GithubClientOptions,
  GithubTokenResolver,
  GithubSearchHit,
  SearchResult as GithubSearchResult,
  PullRequestDetail as GithubPullRequestDetail,
  IssueDetail as GithubIssueDetail,
} from "./client";
