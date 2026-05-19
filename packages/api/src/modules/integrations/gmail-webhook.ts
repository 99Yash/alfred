import { findCredentialByEmail } from "@alfred/integrations/google";
import { serverEnv } from "@alfred/env/server";
import { Elysia, status, t } from "elysia";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getIngestionQueue } from "./queue";

/**
 * Gmail push receiver.
 *
 *   Google -> Pub/Sub topic -> push subscription -> POST /webhooks/gmail
 *
 * Pub/Sub envelope shape:
 *   {
 *     message: {
 *       data: base64(<JSON:{emailAddress, historyId}>),
 *       messageId, publishTime, attributes?
 *     },
 *     subscription: "projects/.../subscriptions/..."
 *   }
 *
 * We never trust the payload by itself. Two checks gate processing:
 *   1. OIDC token on Authorization header (when configured) — proves the
 *      request came from Pub/Sub with the expected service account.
 *   2. The decoded `emailAddress` must map to a known credential row.
 *
 * The handler returns 200 fast (target <500ms) and offloads the actual
 * sync to the ingestion queue. Pub/Sub treats anything but 2xx as
 * delivery failure and retries with exponential backoff, so swallowing
 * already-handled-elsewhere notifications as 200 is the right default.
 */

const GOOGLE_OIDC_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_OIDC_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface PubSubMessage {
  data?: string;
  messageId?: string;
  publishTime?: string;
  attributes?: Record<string, string>;
}

interface PubSubEnvelope {
  message?: PubSubMessage;
  subscription?: string;
}

interface GmailNotificationPayload {
  emailAddress: string;
  historyId: string;
}

interface OidcClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean;
}

async function verifyPubSubOidc(authHeader: string | null): Promise<OidcClaims> {
  const env = serverEnv();
  const audience = env.GOOGLE_PUBSUB_AUDIENCE;
  if (!audience) {
    // OIDC verification disabled (e.g. local dev with ngrok where setting
    // up an audience is fiddly). Caller must explicitly opt out by
    // leaving the env var unset.
    return {};
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("missing Authorization bearer token");
  }
  const token = authHeader.slice("Bearer ".length);
  const { payload } = await jwtVerify<OidcClaims>(token, GOOGLE_OIDC_JWKS, {
    issuer: GOOGLE_OIDC_ISSUERS,
    audience,
  });
  const expectedSa = env.GOOGLE_PUBSUB_SERVICE_ACCOUNT;
  if (expectedSa && payload.email !== expectedSa) {
    throw new Error(`unexpected OIDC email: ${payload.email}`);
  }
  return payload;
}

function decodePayload(data: string | undefined): GmailNotificationPayload | null {
  if (!data) return null;
  try {
    const json = Buffer.from(data, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<GmailNotificationPayload>;
    if (!parsed.emailAddress || !parsed.historyId) return null;
    return { emailAddress: parsed.emailAddress, historyId: parsed.historyId };
  } catch {
    return null;
  }
}

export const gmailWebhookRoutes = new Elysia({ prefix: "/webhooks" }).post(
  "/gmail",
  async ({ body, headers }) => {
    try {
      await verifyPubSubOidc(headers["authorization"] ?? null);
    } catch (err) {
      console.warn(
        "[gmail-webhook] OIDC verification failed:",
        err instanceof Error ? err.message : String(err),
      );
      // 401 → Pub/Sub will retry, but a misconfigured audience would
      // retry forever. Logging at warn level keeps this visible without
      // paging on every notification.
      return status(401, { message: "Invalid OIDC token" });
    }

    const envelope = body as PubSubEnvelope;
    const payload = decodePayload(envelope.message?.data);
    if (!payload) {
      // Malformed payload → 200 to stop retries; nothing we can do with it.
      console.warn(
        "[gmail-webhook] could not decode payload; messageId=",
        envelope.message?.messageId,
      );
      return { ok: true, ignored: "bad-payload" };
    }

    const cred = await findCredentialByEmail(payload.emailAddress);
    if (!cred) {
      // The user may have disconnected; we shouldn't keep retrying. 200.
      console.warn(
        `[gmail-webhook] no credential for ${payload.emailAddress}; messageId=${envelope.message?.messageId}`,
      );
      return { ok: true, ignored: "no-credential" };
    }

    // jobId dedupes in-flight polls for the same credential — multiple
    // webhooks within the poll's runtime collapse to one job. The poll
    // itself reads the latest cursor, so dedupe doesn't drop notifications.
    const queue = getIngestionQueue();
    await queue.add(
      "gmail.poll_history",
      { kind: "gmail.poll_history", credentialId: cred.id, reason: "webhook" },
      { jobId: `gmail.poll_history:${cred.id}` },
    );

    return { ok: true, credentialId: cred.id };
  },
  {
    body: t.Any(),
  },
);
