// One folder per live provider. Google covers Gmail, Calendar, Drive, Docs,
// Sheets, and Slides; GitHub, Notion, Railway, and Vercel have their own
// provider folders. Slack/Linear are catalog/design-only for now.
export * as google from "./google/index";
export * as github from "./github/index";
export * as notion from "./notion/index";
export * as railway from "./railway/index";
export * as vercel from "./vercel/index";
export * as credentials from "./shared/credentials";

// The user-bound facade over the per-provider configured clients:
// `integrations({ userId }).github.search({ q })`. This is the intended door for
// provider access inside a tool dispatch; it covers github + vercel today and
// #551 brings the rest over. Prefer it to a credential function whenever the
// provider is on it.
export { integrations, type Integrations, type IntegrationsOptions } from "./facade";
