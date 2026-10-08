import { serverEnv } from "@alfred/env/server";
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

/**
 * Chat upload storage on Cloudflare R2, through the S3 protocol (ADR-0065). Private
 * bucket, presigned URLs. To change provider, change the `CHAT_S3_*` vars or this adapter.
 * Keys are `chat/{userId}/{threadId}/{messageId}/{file}`, so one prefix delete reaps
 * a thread or account. FK cascades cannot reach object storage.
 */

/** How long a minted upload/download URL stays valid. */
const SIGNED_URL_TTL_SECONDS = 15 * 60;

/** Bound object-store calls so chat sends cannot hang behind a stuck provider. */
const STORAGE_TIMEOUT_MS = 30_000;

const STORAGE_RETRIES = { max: 1 };

let _files: Files | undefined;

/** True when every required `CHAT_S3_*` var is set. The upload route returns 503 otherwise. */
export function isStorageConfigured(): boolean {
  const env = serverEnv();

  return Boolean(
    env.CHAT_S3_BUCKET &&
    env.CHAT_S3_REGION &&
    env.CHAT_S3_ACCESS_KEY_ID &&
    env.CHAT_S3_SECRET_ACCESS_KEY &&
    // Without an endpoint the client silently falls back to the AWS S3 host.
    env.CHAT_S3_ENDPOINT,
  );
}

type ChatStorageEnv = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  publicBaseUrl: string | undefined;
};

function storageEnv(): ChatStorageEnv {
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
    ...(env.endpoint ? { endpoint: env.endpoint } : {}),
    forcePathStyle: env.forcePathStyle,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    // When set, reads return `${base}/${key}`; otherwise `attachmentUrl()` presigns a GET.
    ...(env.publicBaseUrl ? { publicBaseUrl: env.publicBaseUrl } : {}),
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

const PDF_DEGRADED_ARTIFACT_SUFFIX = ".alfred-pdf-text.json";

/** The durable text sidecar owned by one raw PDF object. */
export function pdfDegradedArtifactKey(storageKey: string): string {
  return `${storageKey}${PDF_DEGRADED_ARTIFACT_SUFFIX}`;
}

/** Every sidecar that lives and dies with the raw object. Add new kinds here so cleanup finds them. */
export function degradedArtifactKeysFor(storageKey: string): readonly string[] {
  return [pdfDegradedArtifactKey(storageKey)];
}

/** The raw attachment and every object whose lifecycle it owns. */
export function attachmentObjectKeys(storageKey: string): readonly string[] {
  return [storageKey, ...degradedArtifactKeysFor(storageKey)];
}

/** A short-lived read URL, for the composer preview. The model gets bytes, not a URL. */
export async function attachmentUrl(key: string): Promise<string> {
  return files().url(key, { expiresIn: SIGNED_URL_TTL_SECONDS });
}

/** Read an object's bytes. Images go to the model as bytes: providers cannot fetch our private URLs. */
export async function readObject(key: string): Promise<Uint8Array> {
  const file = await files().download(key);

  return new Uint8Array(await file.arrayBuffer());
}

/** Write bytes from the server; the upload route relays them. The caller checks the size. */
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

/** Server-side copy. A retry copies bytes under the new message key, so each message owns its objects. */
export async function copyObject(from: string, to: string): Promise<void> {
  await files().copy(from, to);
}

/** Delete exact keys. Missing keys are treated as already gone by the provider. */
export async function deleteObjects(keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const result = await files().delete([...keys]);
  const errors = result.errors ?? [];

  if (errors.length > 0) {
    throw new Error(`Failed to delete ${errors.length} object(s) from storage`);
  }

  return result.deleted.length;
}

/** List and delete every object under a prefix, in pages. Idempotent. Returns the count removed. */
export async function deletePrefix(prefix: string): Promise<number> {
  const client = files();
  let removed = 0;
  let cursor: string | undefined;

  do {
    const page = await client.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = page.items.map((f) => f.key);

    if (keys.length > 0) {
      const result = await client.delete(keys);
      removed += result.deleted.length;
      const errors = result.errors ?? [];

      if (errors.length > 0) {
        throw new Error(`Failed to delete ${errors.length} object(s) under storage prefix`);
      }
    }

    cursor = page.cursor;
  } while (cursor);

  return removed;
}
