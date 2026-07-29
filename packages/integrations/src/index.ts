// One folder per live provider. Google covers Gmail, Calendar, Drive, Docs,
// Sheets, and Slides; GitHub, Notion, Railway, and Vercel have their own
// provider folders. Slack/Linear are catalog/design-only for now.
export * as google from "./google/index";
export * as github from "./github/index";
export * as notion from "./notion/index";
export * as railway from "./railway/index";
export * as vercel from "./vercel/index";
export * as credentials from "./shared/credentials";

// The user-bound root over the per-provider configured clients:
// `integrations({ userId }).github.search({ q })`. This is the intended door for
// provider access inside a tool dispatch. Prefer it to credential functions:
// tool code should never resolve or carry provider tokens.
export { integrations, type Integrations, type IntegrationsOptions } from "./integrations";
