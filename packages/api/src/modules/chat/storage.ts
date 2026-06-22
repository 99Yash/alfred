import { serverEnv } from "@alfred/env/server";
import { Files, type SignedUpload } from "files-sdk";
import { s3 } from "files-sdk/s3";

/**
 * Object storage for chat file uploads (ADR-0065). Backed by **Railway storage
 * buckets**, which speak the S3 protocol (`ENDPOINT=https://storage.railway.app`,
 * `REGION=auto`, private-only — presigned URLs, no CDN). `files-sdk`'s `s3`
 * adapter talks that protocol; the `@aws-sdk/client-s3` dependency is just the S3
 * *protocol client* (the standard way to reach any S3-compatible store), not AWS
 * the service. Provider-agnostic on purpose: to move off Railway, point the
 * `CHAT_S3_*` vars elsewhere or swap the adapter here — never the call sites.
 *
 * What the model sees is the degraded artifact (text + images, ADR-0065):
 * phase-1 pass-through images are read back via `readObject` and inlined as
 * bytes, while richer media (audio/video/docs) only ever reaches the model as
 * extracted text plus keyframes. Lifecycle is keyed to a
 * `chat/{userId}/{threadId}/{messageId}/{file}` key convention so a thread or
 * account delete reaps the objects with a single prefix delete (FK cascade can't
 * reach object storage).
 */

/** How long a minted upload/download URL stays valid. */
const SIGNED_URL_TTL_SECONDS = 15 * 60;
/** Bound object-store calls so chat sends cannot hang behind a stuck provider. */
const STORAGE_TIMEOUT_MS = 30_000;
const STORAGE_RETRIES = { max: 1 };

let _files: Files | undefined;

/**
 * True when every required `CHAT_S3_*` var is set. The upload route gates on
 * this and returns a clean 503 when storage isn't provisioned yet — the same
 * boot-before-setup posture as the transcription / Notion / Vercel integrations.
 */
export function isStorageConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.CHAT_S3_BUCKET &&
    env.CHAT_S3_REGION &&
    env.CHAT_S3_ACCESS_KEY_ID &&
    env.CHAT_S3_SECRET_ACCESS_KEY,
  );
}

function storageEnv(): {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  publicBaseUrl: string | undefined;
} {
  const env = serverEnv();
  if (
    !env.CHAT_S3_BUCKET ||
    !env.CHAT_S3_REGION ||
    !env.CHAT_S3_ACCESS_KEY_ID ||
    !env.CHAT_S3_SECRET_ACCESS_KEY
  ) {
    throw new Error("Chat file storage is not configured (CHAT_S3_* env vars missing)");
  }
  return {
    bucket: env.CHAT_S3_BUCKET,
    region: env.CHAT_S3_REGION,
    accessKeyId: env.CHAT_S3_ACCESS_KEY_ID,
    secretAccessKey: env.CHAT_S3_SECRET_ACCESS_KEY,
    endpoint: env.CHAT_S3_ENDPOINT,
    forcePathStyle: env.CHAT_S3_FORCE_PATH_STYLE,
    publicBaseUrl: env.CHAT_S3_PUBLIC_BASE_URL,
  };
}

function files(): Files {
  if (_files) return _files;
  const env = storageEnv();
  const adapter = s3({
    bucket: env.bucket,
    region: env.region,
    // Railway's S3 endpoint (https://storage.railway.app). Any S3-compatible
    // endpoint works here; left unset only in tests / AWS-native setups.
    endpoint: env.endpoint,
    forcePathStyle: env.forcePathStyle,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    // When set, reads return `${base}/${key}` (CDN/public bucket). Otherwise
    // `attachmentUrl()` mints a presigned GET.
    publicBaseUrl: env.publicBaseUrl,
    defaultUrlExpiresIn: SIGNED_URL_TTL_SECONDS,
  });
  _files = new Files({ adapter, timeout: STORAGE_TIMEOUT_MS, retries: STORAGE_RETRIES });
  return _files;
}

/** Strip path separators / control chars so a filename can't escape its key prefix. */
function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file";
}

/**
 * Build the canonical object key for an attachment. The `{messageId}` segment is
 * the message the file is attached to; deletion of a thread/account drops the
 * `chat/{userId}/{threadId}/` or `chat/{userId}/` prefix wholesale.
 */
export function buildAttachmentKey(opts: {
  userId: string;
  threadId: string;
  messageId: string;
  attachmentId: string;
  fileName: string;
}): string {
  // The attachmentId disambiguates same-named files on one message.
  return `chat/${opts.userId}/${opts.threadId}/${opts.messageId}/${opts.attachmentId}-${sanitizeFileName(opts.fileName)}`;
}

/**
 * Mint a direct-to-bucket upload URL for the browser (the server never proxies
 * the file). `maxSize` (the matched ingest policy's per-file cap) is bound into
 * the signature so the bucket write itself is size-limited: files-sdk returns a
 * presigned POST form with a `content-length-range` policy rather than an
 * unbounded PUT URL, closing the "anyone with the URL can upload an arbitrarily
 * large object" hole. `minSize: 1` rejects empty uploads.
 */
export async function signedUploadUrl(
  key: string,
  contentType: string,
  maxSize: number,
): Promise<SignedUpload> {
  return files().signedUploadUrl(key, {
    expiresIn: SIGNED_URL_TTL_SECONDS,
    contentType,
    maxSize,
    minSize: 1,
  });
}

/**
 * A short-lived read URL for an object — used for the composer's image preview
 * (the model gets inlined bytes via `readObject`, not a URL). Presigned GET
 * unless a public base URL is set.
 */
export async function attachmentUrl(key: string): Promise<string> {
  return files().url(key, { expiresIn: SIGNED_URL_TTL_SECONDS });
}

/**
 * Read an object's raw bytes back from the bucket (ADR-0065). Backs the image
 * **bytes path**: pass-through images are inlined into the model message as
 * bytes rather than handed off as a presigned URL. The providers can't fetch
 * our private, short-lived Railway storage URLs (no CDN, no public host), so a
 * URL-valued image part fails the turn on the boss and its fallback alike;
 * inlining the bytes removes that dependency entirely. Bounded by the same
 * `STORAGE_TIMEOUT_MS` as every other object-store call.
 */
export async function readObject(key: string): Promise<Uint8Array> {
  const file = await files().download(key);
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Write bytes straight to the bucket from the server (ADR-0065). Backs the
 * server-proxied upload route: the browser can't PUT/POST direct-to-bucket
 * because the Railway storage provider serves no CORS `Access-Control-Allow-Origin`
 * header, so the client posts the bytes to our API and we relay them here. Size
 * is already policy-checked by the caller before this runs.
 */
export async function writeObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await files().upload(key, bytes, { contentType });
}

/** True when an object already exists at `key`; transport/auth failures still throw. */
export async function objectExists(key: string): Promise<boolean> {
  return files().exists(key);
}

/** Metadata for a stored object, without downloading its body. */
export async function headObject(key: string): Promise<{ size: number; contentType: string }> {
  const file = await files().head(key);
  return { size: file.size, contentType: file.type };
}

/** Read a small byte prefix from an object for server-side type sniffing. */
export async function readObjectPrefix(key: string, byteCount: number): Promise<Uint8Array> {
  const file = await files().download(key, {
    range: { start: 0, end: Math.max(0, byteCount - 1) },
  });
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Server-side copy of one object to a new key — no body re-transfer (ADR-0065).
 * Used by faithful retry: re-sending a failed image-only turn re-attaches the
 * prior message's bytes under the *new* message's key prefix, so each message
 * still owns its objects and the thread-prefix cleanup sweep covers them.
 */
export async function copyObject(from: string, to: string): Promise<void> {
  await files().copy(from, to);
}

/** Delete exact keys. Missing keys are treated as already gone by the provider. */
export async function deleteObjects(keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const result = await files().delete([...keys]);
  return result.deleted.length;
}

/**
 * Delete every object under a key prefix — the thread/account cleanup primitive.
 * Object stores have no FK cascade, so we list-and-delete in pages. Idempotent:
 * a missing prefix is a no-op. Returns the number of objects removed.
 */
export async function deletePrefix(prefix: string): Promise<number> {
  const client = files();
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await client.list({ prefix, cursor });
    const keys = page.items.map((f) => f.key);
    if (keys.length > 0) {
      await client.delete(keys);
      removed += keys.length;
    }
    cursor = page.cursor;
  } while (cursor);
  return removed;
}
