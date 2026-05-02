// One folder per provider (gmail, calendar, slack, linear, github, notion, etc.)
// Each exports: oauthFlow, liveTools, ingestor, webhookHandler.
// Google (Gmail) lands in milestone 7; others arrive on demand.
export * as google from "./google/index";
