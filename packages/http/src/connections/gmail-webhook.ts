import { createHash } from "node:crypto";
import { Errors, eventTypeName, getStringPath, parseJsonWith, toMessage } from "@alfred/contracts";
import {
  assertGmailPushOidcConfigured,
  findCredentialByEmail,
  pubSubOidcConfigFromEnv,
  type PubSubOidcConfig,
} from "@alfred/integrations/google";
import { Elysia, t } from "elysia";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import {
  GMAIL_POLL_DEDUP_TTL_MS,
  getIngestionQueue,
  type IngestionJobData,
} from "@alfred/assistant/connections/ingestion";

/**
 * Gmail push receiver: Pub/Sub -> POST /webhooks/gmail.
 * Checks the OIDC token, the envelope, and a known credential, then queues a poll.
 * Pub/Sub retries every non-2xx, so unusable notifications still get a 200.
 */

const GOOGLE_OIDC_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const GOOGLE_OIDC_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface OidcClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean;
}

type VerifyJwt = (token: string, audience: string) => Promise<OidcClaims>;

type GmailWebhookCredentialLookup = (
  emailAddress: string,
) => Promise<{ id: string; userId: string } | null>;

type GmailWebhookQueue = {
  add: (
    name: "gmail.poll_recent",
    data: Extract<IngestionJobData, { kind: "gmail.poll_recent" }>,
    options: { deduplication: { id: string; ttl: number } },
  ) => Promise<void>;
};

/** Persist a receipt keyed by Pub/Sub messageId. A redelivery returns `{ inserted: false }`. */
export type GmailWebhookReceiptPersister = (args: {
  providerDeliveryId: string;
  credentialId: string;
  userId: string;
  historyId: string;
  verificationResult: string;
  payloadHash: string;
}) => Promise<{ inserted: boolean }>;

async function verifyGoogleOidcJwt(token: string, audience: string): Promise<OidcClaims> {
  const { payload } = await jwtVerify<OidcClaims>(token, GOOGLE_OIDC_JWKS, {
    issuer: GOOGLE_OIDC_ISSUERS,
    audience,
  });

  return payload;
}

export async function verifyPubSubOidcForGmailWebhook(
  authHeader: string | null,
  options: {
    config?: PubSubOidcConfig;
    verifyJwt?: VerifyJwt;
  } = {},
): Promise<OidcClaims> {
  const config = options.config ?? pubSubOidcConfigFromEnv();
  const audience = config.audience;

  if (!audience) {
    assertGmailPushOidcConfigured(config);

    // No audience configured: local and test only.
    return {};
  }

  assertGmailPushOidcConfigured(config);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("missing Authorization bearer token");
  }

  const token = authHeader.slice("Bearer ".length);
  const payload = await (options.verifyJwt ?? verifyGoogleOidcJwt)(token, audience);
  const expectedSa = config.expectedServiceAccount;

  if (expectedSa && payload.email !== expectedSa) {
    throw new Error(`unexpected OIDC email: ${payload.email}`);
  }

  if (expectedSa && payload.email_verified !== true) {
    throw new Error("OIDC email claim is not verified");
  }

  return payload;
}

const gmailPushNotificationSchema = z.object({
  emailAddress: z.string().min(1),
  // A presence check only. Google sends a number and the test fixture a string;
  // `z.string()` alone would reject every real notification.
  historyId: z.union([z.string(), z.number()]).refine((value) => Boolean(value)),
});

/**
 * Never throws: a bad body gives `notification: null` and a 200.
 * The route uses `t.Unknown()` because a schema 400 makes Pub/Sub retry forever.
 * Known gap: Elysia parses JSON before this runs, so malformed JSON still gets a 400.
 */
export interface GmailPushEnvelope {
  messageId: string | undefined;
  notification: z.infer<typeof gmailPushNotificationSchema> | null;
}

export function parseGmailPushEnvelope(body: unknown): GmailPushEnvelope {
  const messageId = getStringPath(body, "message", "messageId");
  const data = getStringPath(body, "message", "data");

  if (data === undefined) return { messageId, notification: null };

  // Base64 decoding never throws; it drops invalid characters.
  const json = Buffer.from(data, "base64").toString("utf8");

  return { messageId, notification: parseJsonWith(json, gmailPushNotificationSchema) };
}

/** The receipt is the audit trail and the source of truth for gap detection (ADR-0090). */
async function defaultPersistReceipt(args: {
  providerDeliveryId: string;
  credentialId: string;
  userId: string;
  historyId: string;
  verificationResult: string;
  payloadHash: string;
}): Promise<{ inserted: boolean }> {
  const { eventReceipts } = await import("@alfred/db/schemas");
  const { db } = await import("@alfred/db");

  const row = await db()
    .insert(eventReceipts)
    .values({
      provider: "google",
      providerDeliveryId: args.providerDeliveryId,
      credentialId: args.credentialId,
      userId: args.userId,
      eventType: eventTypeName("gmail", "message_received"),
      historyId: args.historyId,
      verificationResult: args.verificationResult,
      payloadHash: args.payloadHash,
      processingStatus: "pending",
    })
    .onConflictDoNothing({
      target: [eventReceipts.provider, eventReceipts.providerDeliveryId],
    })
    .returning({ id: eventReceipts.id });

  return { inserted: row.length > 0 };
}

export function makeGmailWebhookRoutes(
  deps: {
    verifyOidc?: (authHeader: string | null) => Promise<OidcClaims>;
    findCredential?: GmailWebhookCredentialLookup;
    getQueue?: () => GmailWebhookQueue;
    persistReceipt?: GmailWebhookReceiptPersister;
  } = {},
) {
  const verifyOidc = deps.verifyOidc ?? verifyPubSubOidcForGmailWebhook;
  const findCredential = deps.findCredential ?? findCredentialByEmail;
  const getQueue = deps.getQueue ?? getIngestionQueue;
  const persistReceipt = deps.persistReceipt ?? defaultPersistReceipt;

  return new Elysia({ prefix: "/webhooks", normalize: "typebox" }).post(
    "/gmail",
    async ({ body, headers }) => {
      let verificationResult: "oidc_skipped" | "oidc_valid" = "oidc_skipped";

      try {
        await verifyOidc(headers["authorization"] ?? null);
        verificationResult = "oidc_valid";
      } catch (err) {
        console.warn("[gmail-webhook] OIDC verification failed:", toMessage(err));
        // Pub/Sub retries a 401, so a wrong audience retries forever.
        throw Errors.UnauthorizedError("Invalid OIDC token");
      }

      const { messageId, notification } = parseGmailPushEnvelope(body);

      if (!notification) {
        console.warn("[gmail-webhook] could not decode payload; messageId=", messageId);

        return { ok: true, ignored: "bad-payload" };
      }

      const cred = await findCredential(notification.emailAddress);

      if (!cred) {
        // Probably disconnected. A 200 stops the retries.
        console.warn(
          `[gmail-webhook] no credential for ${notification.emailAddress}; messageId=${messageId}`,
        );

        return { ok: true, ignored: "no-credential" };
      }

      // Audit only: key order changes the hash, so never use it for dedup.
      // drift-ok: audit-only receipt digest, never compared against another hash; dedup is the (provider, provider_delivery_id) index
      const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const historyId = String(notification.historyId);

      const receipt = messageId
        ? await persistReceipt({
            providerDeliveryId: messageId,
            credentialId: cred.id,
            userId: cred.userId,
            historyId,
            verificationResult,
            payloadHash,
          })
        : { inserted: false };

      // A TTL dedup collapses bursts. Not a static `jobId`: BullMQ keeps completed jobs,
      // so a reused id is a silent no-op for hours. Poll, not history.list, which lags (ADR-0037).
      const queue = getQueue();
      await queue.add(
        "gmail.poll_recent",
        { kind: "gmail.poll_recent", credentialId: cred.id, pushHistoryId: historyId },
        {
          deduplication: {
            id: `gmail.poll_recent.${cred.id}`,
            ttl: GMAIL_POLL_DEDUP_TTL_MS,
          },
        },
      );

      return { ok: true, credentialId: cred.id, receiptPersisted: receipt.inserted };
    },
    {
      // Not a rejecting schema; see `parseGmailPushEnvelope`.
      body: t.Unknown(),
    },
  );
}

export const gmailWebhookRoutes = makeGmailWebhookRoutes();
