import { serverEnv } from "@alfred/env/server";

export interface PubSubOidcConfig {
  nodeEnv: "development" | "production" | "test";
  pushTopic?: string;
  audience?: string;
  expectedServiceAccount?: string;
}

export class GmailPushOidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailPushOidcConfigError";
  }
}

export function pubSubOidcConfigFromEnv(): PubSubOidcConfig {
  const env = serverEnv();
  return {
    nodeEnv: env.NODE_ENV,
    pushTopic: env.GOOGLE_PUBSUB_TOPIC,
    audience: env.GOOGLE_PUBSUB_AUDIENCE,
    expectedServiceAccount: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT,
  };
}

export function isGmailPushOidcConfigError(err: unknown): err is GmailPushOidcConfigError {
  return err instanceof GmailPushOidcConfigError;
}

export function assertGmailPushOidcConfigured(config = pubSubOidcConfigFromEnv()): void {
  if (config.nodeEnv !== "production" && !config.pushTopic) return;
  if (!config.audience) {
    throw new GmailPushOidcConfigError(
      "GOOGLE_PUBSUB_AUDIENCE is required when Gmail push is enabled",
    );
  }
  if (!config.expectedServiceAccount) {
    throw new GmailPushOidcConfigError(
      "GOOGLE_PUBSUB_SERVICE_ACCOUNT is required when Gmail push is enabled",
    );
  }
}
