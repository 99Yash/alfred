import { serverEnv } from "@alfred/env/server";

export interface PubSubOidcConfig {
  nodeEnv: "development" | "production" | "test";
  audience?: string;
  expectedServiceAccount?: string;
}

export function pubSubOidcConfigFromEnv(): PubSubOidcConfig {
  const env = serverEnv();
  return {
    nodeEnv: env.NODE_ENV,
    audience: env.GOOGLE_PUBSUB_AUDIENCE,
    expectedServiceAccount: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT,
  };
}

export function assertGmailPushOidcConfigured(config = pubSubOidcConfigFromEnv()): void {
  if (config.nodeEnv !== "production") return;
  if (!config.audience) {
    throw new Error("GOOGLE_PUBSUB_AUDIENCE is required in production");
  }
  if (!config.expectedServiceAccount) {
    throw new Error("GOOGLE_PUBSUB_SERVICE_ACCOUNT is required in production");
  }
}
