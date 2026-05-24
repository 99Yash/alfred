// One folder per provider (gmail, calendar, slack, linear, github, notion, etc.)
// Each exports: oauthFlow, liveTools, ingestor, webhookHandler.
// Google (Gmail + Calendar) lands in milestones 7/12; others arrive on demand.
export * as google from "./google/index";
export * as github from "./github/index";
