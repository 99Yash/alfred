export {
  buildVercelInstallUrl,
  exchangeVercelCode,
  getVercelOAuthConfig,
  isVercelConfigured,
} from "./oauth";

export type { VercelOAuthConfig, VercelTokenResult } from "./oauth";

// `readVercelTeamId` is not exported: only the client reads the team scope.
export { vercelCredentialMetadata } from "./credential";

export { createVercelClient, vercelClientForUser } from "./client";

export type {
  VercelAuthResolver,
  VercelClient,
  VercelClientOptions,
  VercelDeployment,
  VercelDeploymentGit,
  VercelProject,
  VercelRedeployResult,
} from "./client";
