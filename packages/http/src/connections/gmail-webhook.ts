import { createHash } from "node:crypto";
import { Errors, getStringPath, parseJsonWith, toMessage } from "@alfred/contracts";
import {
  assertGmailPushOidcConfigured,
  findCredentialByEmail,
  pubSubOidcConfigFromEnv,
  type PubSubOidcConfig,
} from "@alfred/integrations/google";
import { Elysia, t } from "elysia";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { getIngestionQueue } from "@alfred/assistant/connections/ingestion";

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
 * We never trust the payload by itself. Three checks gate processing:
 *   1. OIDC token on Authorization header (when configured) — proves the
 *      request came from Pub/Sub with the expected service account.
 *   2. `parseGmailPushEnvelope` reads the envelope fields with `getStringPath`
 *      and validates the decoded notification against the schema below. The
 *      route body stays `t.Unknown()` on purpose; see that function's header.
 *   3. The decoded `emailAddress` must map to a known credential row.
 *
 * The handler returns 200 fast (target <500ms) and offloads the actual
 * sync to the ingestion queue. Pub/Sub treats anything but 2xx as
 * delivery failure and retries with exponential backoff, so swallowing
 * already-handled-elsewhere notifications as 200 is the right default.
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
    data: { kind: "gmail.poll_recent"; credentialId: string; pushHistoryId?: string },
    options: { deduplication: { id: string; ttl: number } },
  ) => Promise<unknown>;
};

/**
 * #560a: persist a durable event receipt keyed by Pub/Sub messageId.
 * The unique index on `(provider, provider_delivery_id)` catches redeliveries;
 * an `onConflictDoNothing` insert returns `{ inserted: false }` for duplicates.
 */
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
    // OIDC verification is disabled only for local/test webhook exercises
    // where setting up a signed Pub/Sub push token is unnecessary friction.
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
  // Nothing downstream reads `historyId`; it is a presence gate only, and it
  // keeps the base handler's `!parsed.historyId` check. Google's push payload
  // sends it as a JSON number and our test fixture sends a string, so accept
  // both. A `z.string()` spelling here would answer `bad-payload` for every
  // production notification while the suite stayed green.
  historyId: z.union([z.string(), z.number()]).refine((value) => Boolean(value)),
});

/**
 * The single door from the wire body to a domain value. Total: it never throws,
 * and every body it receives yields either a validated notification or a
 * `notification` of `null`, which the handler answers 200 for. `messageId` is
 * for the log line only.
 *
 * The route keeps `body: t.Unknown()` rather than a rejecting typebox schema
 * because `errorHandler` maps an Elysia `VALIDATION` code to 400, and Pub/Sub
 * retries every non-2xx with backoff — so a rejecting schema would retry a
 * permanently invalid body forever.
 *
 * That covers route validation only. One arm stays open, and it is accepted
 * residual risk rather than a claim this function holds: Elysia parses the body
 * by content type BEFORE route validation, so bytes that are not JSON under
 * `content-type: application/json` raise `PARSE`, which `errorHandler` maps to
 * 400 through a door this function never sees. Under the production
 * `@elysiajs/node` adapter that arm covers malformed JSON text, an empty-string
 * body and an absent body. Base `315823c5` answers 400 for all of them too, so
 * nothing regressed here; campaign item 210 owns whether to close the arm with
 * a `parse: ({ request }) => request.text()` hook, as `github-webhook.ts` does.
 */
export function parseGmailPushEnvelope(body: unknown): {
  messageId: string | undefined;
  notification: z.infer<typeof gmailPushNotificationSchema> | null;
} {
  // `getStringPath` walks a body of any shape and accepts only a string leaf, so
  // a non-object root, a wrong-typed `message` and a wrong-typed `messageId` all
  // read as absent instead of failing the whole envelope. Fields nothing reads —
  // `publishTime`, `attributes`, `subscription` — cannot invent a rejection.
  const messageId = getStringPath(body, "message", "messageId");
  const data = getStringPath(body, "message", "data");
  if (data === undefined) return { messageId, notification: null };

  // `Buffer.from(x, "base64")` never throws; it drops any character outside the
  // alphabet. `parseJsonWith` owns the malformed-JSON and failed-schema arms.
  const json = Buffer.from(data, "base64").toString("utf8");
  return { messageId, notification: parseJsonWith(json, gmailPushNotificationSchema) };
}

/**
 * #560a: default receipt persister — inserts into `event_receipts` with
 * `onConflictDoNothing` on the unique `(provider, provider_delivery_id)` index.
 * Returns whether the row was newly inserted (duplicate redeliveries are no-ops).
 */
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
      eventType: "gmail.message_received",
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
      let verificationResult = "oidc_skipped";
      try {
        await verifyOidc(headers["authorization"] ?? null);
        verificationResult = "oidc_valid";
      } catch (err) {
        console.warn("[gmail-webhook] OIDC verification failed:", toMessage(err));
        // 401 → Pub/Sub will retry, but a misconfigured audience would
        // retry forever. Logging at warn level keeps this visible without
        // paging on every notification.
        throw Errors.UnauthorizedError("Invalid OIDC token");
      }

      const { messageId, notification } = parseGmailPushEnvelope(body);
      if (!notification) {
        // Malformed payload → 200 to stop retries; nothing we can do with it.
        console.warn("[gmail-webhook] could not decode payload; messageId=", messageId);
        return { ok: true, ignored: "bad-payload" };
      }

      const cred = await findCredential(notification.emailAddress);
      if (!cred) {
        // The user may have disconnected; we shouldn't keep retrying. 200.
        console.warn(
          `[gmail-webhook] no credential for ${notification.emailAddress}; messageId=${messageId}`,
        );
        return { ok: true, ignored: "no-credential" };
      }

      // #560a: persist a durable receipt before enqueuing. The DB unique index
      // on (provider, provider_delivery_id) catches Pub/Sub redeliveries; a
      // duplicate insert is a no-op. A crash after receipt commit but before
      // queue enqueue is recovered from the pending receipt status.
      const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const receipt = messageId
        ? await persistReceipt({
            providerDeliveryId: messageId,
            credentialId: cred.id,
            userId: cred.userId,
            historyId: String(notification.historyId),
            verificationResult,
            payloadHash,
          })
        : { inserted: false };

      // Deduplicate rapid-fire pushes for the same credential — Pub/Sub can
      // redeliver and Gmail can publish multiple history changes per second.
      // The TTL window collapses bursts but releases quickly so a *new* push
      // arriving 30s later still enqueues a fresh poll. (Static `jobId` doesn't
      // work here — BullMQ keeps completed jobs around per `removeOnComplete`,
      // so re-enqueues with the same id become silent no-ops for hours.)
      //
      // Routes to `gmail.poll_recent` (ADR-0037) — Gmail's search index is the
      // realtime-consistent surface; history.list lags pub/sub and is now
      // demoted to the 5-min catch-up sweep.
      const queue = getQueue();
      await queue.add(
        "gmail.poll_recent",
        { kind: "gmail.poll_recent", credentialId: cred.id, pushHistoryId: String(notification.historyId) },
        { deduplication: { id: `gmail.poll_recent.${cred.id}`, ttl: 30_000 } },
      );

      return { ok: true, credentialId: cred.id, receiptPersisted: receipt.inserted };
    },
    {
      // Not a rejecting schema — see `parseGmailPushEnvelope`. `t.Unknown()`
      // also types `body` as `unknown`, so no handler can read a wire field
      // without going through that door.
      body: t.Unknown(),
    },
  );
}

export const gmailWebhookRoutes = makeGmailWebhookRoutes();
