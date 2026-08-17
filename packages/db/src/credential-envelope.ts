import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * One versioned envelope format. Keep its wire values together so a future
 * format revision changes one declaration.
 */
const FORMAT = {
  algorithm: "A256GCM",
  cipher: "aes-256-gcm",
  prefix: "acv1",
  keyBytes: 32,
  nonceBytes: 12,
  tagBytes: 16,
  kidBytes: 8,
  partCount: 9,
  separator: ".",
} as const;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const ENVELOPE_FAMILY_PATTERN = /^acv\d+\./;

/** Reasons a persisted value is not openable. Never carries the value itself. */
export type CredentialVaultFailure =
  | "not_a_string"
  | "malformed_envelope"
  | "unsupported_version"
  | "unsupported_algorithm"
  | "unknown_key"
  | "authentication_failed"
  | "already_sealed"
  | "invalid_key_length"
  | "plaintext_remaining"
  | "unopenable_remaining";

/**
 * A redacted credential-vault failure. `detail` is only for non-secret
 * operational context, such as a row count.
 */
export class CredentialVaultError extends Error {
  readonly failure: CredentialVaultFailure;

  constructor(failure: CredentialVaultFailure, detail?: string) {
    super(`[credential-vault] ${failure}${detail ? `: ${detail}` : ""}`);
    this.name = "CredentialVaultError";
    this.failure = failure;
  }
}

declare const sealedCredentialSecret: unique symbol;

/**
 * A sealed token as stored in a Postgres `text` column. It is deliberately not
 * assignable to `string`, so implicit provider use does not compile. The runtime
 * value is still a string; `CredentialVault.open` is the public conversion.
 */
export type SealedCredentialSecret = symbol & {
  readonly [sealedCredentialSecret]: true;
};

export interface CredentialVault {
  seal(plaintext: string): SealedCredentialSecret;
  open(persisted: unknown): string;
  /** Marker test only. It does not prove version, format, key, or authenticity. */
  isSealed(persisted: unknown): persisted is SealedCredentialSecret;
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Single-assertion boundary: the sealed envelope is a string at runtime. */
function toSealedEnvelope(joined: string): SealedCredentialSecret {
  // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: envelope is a string at runtime but branded as symbol to prevent implicit provider use
  return joined as unknown as SealedCredentialSecret;
}

/** Decode strictly because Node's base64url decoder ignores invalid bytes. */
function decode(part: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(part)) throw new CredentialVaultError("malformed_envelope");
  const bytes = Buffer.from(part, "base64url");
  if (encode(bytes) !== part || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    throw new CredentialVaultError("malformed_envelope");
  }
  return bytes;
}

function keyId(key: Uint8Array): string {
  return encode(createHash("sha256").update(key).digest().subarray(0, FORMAT.kidBytes));
}

function additionalData(kid: string, role: "dek" | "payload"): Buffer {
  return Buffer.from([FORMAT.prefix, FORMAT.algorithm, kid, role].join(FORMAT.separator), "utf8");
}

/**
 * Recognize every Alfred credential-envelope version before parsing it. This is
 * deliberately broader than the current format: conversion must fail closed on
 * a future, unsupported, or damaged envelope instead of wrapping it as
 * plaintext and making the damaged value look valid.
 */
function belongsToEnvelopeFamily(persisted: unknown): persisted is SealedCredentialSecret {
  return typeof persisted === "string" && ENVELOPE_FAMILY_PATTERN.test(persisted);
}

/**
 * Build an AES-256-GCM envelope vault around an explicit key-encryption key.
 * Production key resolution belongs to `credential-vault.ts`.
 */
export function createCredentialVault(kek: Uint8Array): CredentialVault {
  if (kek.length !== FORMAT.keyBytes) {
    throw new CredentialVaultError("invalid_key_length");
  }
  const key = Buffer.from(kek);
  const kid = keyId(key);

  function seal(plaintext: string): SealedCredentialSecret {
    if (belongsToEnvelopeFamily(plaintext)) {
      throw new CredentialVaultError("already_sealed");
    }
    const dek = randomBytes(FORMAT.keyBytes);
    try {
      const wrapNonce = randomBytes(FORMAT.nonceBytes);
      const wrapper = createCipheriv(FORMAT.cipher, key, wrapNonce);
      wrapper.setAAD(additionalData(kid, "dek"));
      const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
      const wrapTag = wrapper.getAuthTag();

      const nonce = randomBytes(FORMAT.nonceBytes);
      const cipher = createCipheriv(FORMAT.cipher, dek, nonce);
      cipher.setAAD(additionalData(kid, "payload"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      return toSealedEnvelope(
        [
          FORMAT.prefix,
          FORMAT.algorithm,
          kid,
          encode(wrapNonce),
          encode(wrappedDek),
          encode(wrapTag),
          encode(nonce),
          encode(ciphertext),
          encode(tag),
        ].join(FORMAT.separator),
      );
    } finally {
      dek.fill(0);
    }
  }

  function open(persisted: unknown): string {
    if (typeof persisted !== "string") throw new CredentialVaultError("not_a_string");
    const parts = persisted.split(FORMAT.separator);
    if (parts.length !== FORMAT.partCount) {
      throw new CredentialVaultError("malformed_envelope");
    }
    const [
      prefix,
      algorithm,
      envelopeKid,
      rawWrapNonce,
      rawWrappedDek,
      rawWrapTag,
      rawNonce,
      rawCiphertext,
      rawTag,
    ] = parts;
    if (prefix !== FORMAT.prefix) throw new CredentialVaultError("unsupported_version");
    if (algorithm !== FORMAT.algorithm) {
      throw new CredentialVaultError("unsupported_algorithm");
    }
    if (
      envelopeKid === undefined ||
      rawWrapNonce === undefined ||
      rawWrappedDek === undefined ||
      rawWrapTag === undefined ||
      rawNonce === undefined ||
      rawCiphertext === undefined ||
      rawTag === undefined
    ) {
      throw new CredentialVaultError("malformed_envelope");
    }
    decode(envelopeKid, FORMAT.kidBytes);
    if (envelopeKid !== kid) throw new CredentialVaultError("unknown_key");

    const wrapNonce = decode(rawWrapNonce, FORMAT.nonceBytes);
    const wrappedDek = decode(rawWrappedDek, FORMAT.keyBytes);
    const wrapTag = decode(rawWrapTag, FORMAT.tagBytes);
    const nonce = decode(rawNonce, FORMAT.nonceBytes);
    const ciphertext = decode(rawCiphertext);
    const tag = decode(rawTag, FORMAT.tagBytes);

    let dek: Buffer | undefined;
    try {
      const unwrapper = createDecipheriv(FORMAT.cipher, key, wrapNonce);
      unwrapper.setAAD(additionalData(kid, "dek"));
      unwrapper.setAuthTag(wrapTag);
      dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()]);
      if (dek.length !== FORMAT.keyBytes) {
        throw new CredentialVaultError("malformed_envelope");
      }

      const decipher = createDecipheriv(FORMAT.cipher, dek, nonce);
      decipher.setAAD(additionalData(kid, "payload"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError("authentication_failed");
    } finally {
      dek?.fill(0);
    }
  }

  return {
    seal,
    open,
    isSealed: belongsToEnvelopeFamily,
  };
}
