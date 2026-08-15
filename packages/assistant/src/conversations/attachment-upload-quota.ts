import {
  Errors,
  isApiError,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  toMessage,
} from "@alfred/contracts";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";

/**
 * The attachment upload quota: a per-user rate limit, a per-message count and
 * byte cap, and a per-user budget of bytes reserved but not yet accepted by a
 * turn. All four counters live in Redis because the API runs more than one
 * process and the cap has to hold across all of them.
 *
 * The reserve/release pair is the part to read carefully.
 * `assertAttachmentUploadBudgetAllowed` RESERVES `size` pending bytes for the
 * user; `releasePendingUploadBudget` gives them back. Exactly one of two things
 * releases a reservation: the upload route's `catch`, when a later step of the
 * same upload throws, or `startChatTurn`, when the turn that carries those
 * bytes commits. A leak here silently shrinks the user's upload budget until
 * the hour TTL expires; a double release lets them exceed it.
 */

const ATTACHMENT_UPLOAD_RATE_LIMIT_SECONDS = 60;
const ATTACHMENT_UPLOAD_RATE_LIMIT_COUNT = 30;
const ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS = 60 * 60;
const MAX_PENDING_ATTACHMENT_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES_PER_MESSAGE * 4;
let attachmentUploadRateRedis: BoundedRedis | undefined;

function getAttachmentUploadRateRedis(): BoundedRedis {
  // `"command"`, not `"fail-fast"`: these counters ARE the upload quota, so
  // nothing else can answer for them. `assertAttachmentUploadRateAllowed` fails
  // CLOSED on a rejection, and a `"fail-fast"` handle rejects its first command
  // after construction even against a healthy Redis — which 503'd the first
  // attachment upload of every process (#127).
  attachmentUploadRateRedis ??= createRedisConnection("command");
  return attachmentUploadRateRedis;
}

async function incrementUploadCounter(
  key: string,
  amount: number,
  ttlSeconds: number,
): Promise<number> {
  const redis = getAttachmentUploadRateRedis();
  const value = amount === 1 ? await redis.incr(key) : await redis.incrby(key, amount);
  if (value === amount) await redis.expire(key, ttlSeconds);
  return value;
}

export async function releasePendingUploadBudget(userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  try {
    const redis = getAttachmentUploadRateRedis();
    const key = `quota:chat:attachments:pending-bytes:${userId}`;
    const value = await redis.decrby(key, amount);
    if (value <= 0) await redis.del(key);
  } catch (err) {
    console.warn("[chat] pending attachment quota release failed:", toMessage(err));
  }
}

export async function assertAttachmentUploadRateAllowed(userId: string): Promise<void> {
  try {
    const bucket = Math.floor(Date.now() / (ATTACHMENT_UPLOAD_RATE_LIMIT_SECONDS * 1000));
    const rateKey = `rate:chat:attachments:upload:${userId}:${bucket}`;
    const rateCount = await incrementUploadCounter(
      rateKey,
      1,
      ATTACHMENT_UPLOAD_RATE_LIMIT_SECONDS,
    );
    if (rateCount > ATTACHMENT_UPLOAD_RATE_LIMIT_COUNT) {
      throw Errors.TooManyRequestsError("Too many attachment uploads. Try again in a minute.");
    }
  } catch (err) {
    if (isApiError(err, "TOO_MANY_REQUESTS")) throw err;
    console.warn("[chat] attachment upload rate limit unavailable:", toMessage(err));
    throw Errors.ServiceUnavailableError("Attachment upload quota is unavailable. Try again.");
  }
}

export async function assertAttachmentUploadBudgetAllowed(args: {
  userId: string;
  threadId: string;
  messageId: string;
  size: number;
}): Promise<void> {
  try {
    const messageKey = `quota:chat:attachments:message:${args.userId}:${args.threadId}:${args.messageId}`;
    const messageCount = await incrementUploadCounter(
      `${messageKey}:count`,
      1,
      ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS,
    );
    const messageBytes = await incrementUploadCounter(
      `${messageKey}:bytes`,
      args.size,
      ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS,
    );
    if (messageCount > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw Errors.BadRequestError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
    }
    if (messageBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
      const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
      throw Errors.BadRequestError(`Attachments are too large — the combined limit is ${mb} MB`);
    }

    const pendingBytes = await incrementUploadCounter(
      `quota:chat:attachments:pending-bytes:${args.userId}`,
      args.size,
      ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS,
    );
    if (pendingBytes > MAX_PENDING_ATTACHMENT_UPLOAD_BYTES) {
      await releasePendingUploadBudget(args.userId, args.size);
      throw Errors.TooManyRequestsError("Too many pending attachment uploads. Try again later.");
    }
  } catch (err) {
    if (isApiError(err, "BAD_REQUEST", "TOO_MANY_REQUESTS")) throw err;
    console.warn("[chat] attachment upload quota unavailable:", toMessage(err));
    throw Errors.ServiceUnavailableError("Attachment upload quota is unavailable. Try again.");
  }
}
