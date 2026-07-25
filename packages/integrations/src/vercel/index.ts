export {
  buildVercelInstallUrl,
  exchangeVercelCode,
  getVercelOAuthConfig,
  isVercelConfigured,
} from "./oauth";
export type { VercelOAuthConfig, VercelTokenResult } from "./oauth";
// The connect route's half of the credential-metadata contract. Its reader
// (`readVercelTeamId`) is deliberately NOT re-exported: the only thing that needs
// to read the team scope is the client below, so a call site never learns the key.
export { vercelCredentialMetadata } from "./credential";
// The ONE door to Vercel's REST API on a user's behalf — the curated reads,
// `redeploy`, and the passthrough transport profile. Application code reaches it
// through `ctx.integrations.vercel`, which binds the user for it; nothing outside
// `client.ts` needs a token or a team id to talk to Vercel.
export { createVercelClient, vercelClientForUser } from "./client";
export type {
  VercelAuthResolver,
  VercelClient,
  VercelClientOptions,
  VercelDeployment,
  VercelProject,
  VercelRedeployResult,
} from "./client";
