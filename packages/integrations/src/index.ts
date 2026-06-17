// One folder per provider (gmail, calendar, slack, linear, github, notion, etc.)
// Each exports: oauthFlow, liveTools, ingestor, webhookHandler.
// Google (Gmail + Calendar) lands in milestones 7/12; others arrive on demand.
export * as google from "./google/index";
export * as github from "./github/index";
export * as notion from "./notion/index";
export * as railway from "./railway/index";
export * as vercel from "./vercel/index";
export * as credentials from "./shared/credentials";
