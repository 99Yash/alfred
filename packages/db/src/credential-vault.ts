import { serverEnv } from "@alfred/env/server";
import { eq } from "drizzle-orm";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db } from "./index";
import { account } from "./schema/auth";
import { integrationCredentials } from "./schema/integrations";

/**
 * The persisted representation of an OAuth credential secret (#453).
 *
 * Every `access_token`, `refresh_token`, and `id_token` byte that reaches
 * Postgres passes through here. A leaked row, a leaked read replica, or an
 * off-platform backup therefore yields an authenticated envelope rather than a
 * bearer token somebody can replay against Google, GitHub, Notion, Vercel, or
 * Railway.
 *
 * What this defends and what it does not (see the ADR-0038 amendment): the
 * key-encryption key (KEK) lives beside the application in its secret
 * environment, so this does **not** defend against code execution on the app
 * server — that attacker reads the KEK and calls `open` exactly like Alfred
 * does. It defends the far likelier failure: a database artifact that travels
 * without the secret environment attached to it.
 *
 * Envelope encryption, not direct encryption. A per-secret 256-bit data
 * encryption key (DEK) encrypts the token; the KEK only ever wraps DEKs. A
 * future KEK rotation therefore rewraps 32 bytes per row instead of
 * re-encrypting every payload.
 */

/** `aes-256-gcm` — the one algorithm this version speaks. */
const ALGORITHM = "A256GCM";
const NODE_CIPHER = "aes-256-gcm";
/** Envelope format marker. Bump with the format, never with the key. */
const PREFIX = "acv1";
const KEK_BYTES = 32;
const DEK_BYTES = 32;
/** 96-bit nonces, the size AES-GCM is specified for. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Truncated KEK fingerprint. Names which key sealed a row without revealing it. */
const KID_BYTES = 8;
/** prefix · algorithm · kid · wrapNonce · wrappedDek · wrapTag · nonce · ciphertext · tag */
const PART_COUNT = 9;
const PART_SEPARATOR = ".";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

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
 * A credential-vault failure. The message names the failure kind and nothing
 * else: an error that quoted its input would copy the ciphertext — or, for a
 * row the backfill missed, the plaintext token — into every log sink that
 * touches it. `detail` exists for non-secret operational context such as a row
 * count; never pass a token, a column value, or a row id through it.
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
 * A sealed token as it is stored. Physically a `text` column value, and
 * deliberately **not** a `string` to the type system: the only way out of this
 * type is {@link CredentialVault.open}.
 *
 * Why the base is `symbol` rather than `string`. A `string & { brand }` is still
 * assignable to `string`, so it guards only the direction nobody was going:
 * `` `Bearer ${row.accessToken}` `` and `"Bearer " + row.accessToken` both
 * compile against it and ship an envelope to a provider. Intersecting with
 * `symbol` makes TypeScript reject implicit string conversion — TS2731 for a
 * template literal, TS2469 for `+`, TS2339 for `.length` — on top of every
 * `string` parameter and assignment, so an accidental plaintext/ciphertext
 * confusion cannot compile in either direction. The base type is a claim about
 * what a caller may do with the value, not about its runtime representation; the
 * value is a string at run time and `text` in Postgres.
 *
 * What still compiles, honestly: an *explicit* conversion — `String(value)`, a
 * `JSON.stringify` of the whole row, an `as unknown as string`. Those are
 * deliberate acts, and the point of the brand is that the careless spelling is
 * not one of them.
 *
 * The runtime parser in `open` stays authoritative regardless, because a value
 * read out of Postgres is `unknown` no matter what the column type says.
 */
export type SealedCredentialSecret = symbol & {
  readonly [sealedCredentialSecret]: true;
};

export interface CredentialVault {
  /** Wrap a plaintext token for persistence. Throws if handed a sealed value. */
  seal(plaintext: string): SealedCredentialSecret;
  /** Validate and decrypt a persisted value. Throws on anything else. */
  open(persisted: unknown): string;
  /** Envelope-shape test for the backfill. Not an authorization check. */
  isSealed(persisted: unknown): persisted is SealedCredentialSecret;
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Strict base64url decode. `Buffer.from(s, "base64url")` silently skips
 * characters it does not recognize, so a corrupted envelope would decode to
 * *something* and fail later as a confusing authentication error instead of a
 * clear malformed-envelope one. Re-encoding and comparing closes that.
 */
function decode(part: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(part)) throw new CredentialVaultError("malformed_envelope");
  const bytes = Buffer.from(part, "base64url");
  if (encode(bytes) !== part) throw new CredentialVaultError("malformed_envelope");
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new CredentialVaultError("malformed_envelope");
  }
  return bytes;
}

function keyId(kek: Uint8Array): string {
  return encode(createHash("sha256").update(kek).digest().subarray(0, KID_BYTES));
}

/**
 * Additional authenticated data. Binds each ciphertext to the envelope header
 * *and* to its own role, so a wrapped DEK can never be fed to the payload
 * decryption step (or the reverse) and a header edit fails the tag check.
 */
function aad(kid: string, role: "dek" | "payload"): Buffer {
  return Buffer.from([PREFIX, ALGORITHM, kid, role].join(PART_SEPARATOR), "utf8");
}

/** Envelope shape only: correct part count, marker, and fixed field widths. */
function looksSealed(persisted: unknown): boolean {
  if (typeof persisted !== "string") return false;
  const parts = persisted.split(PART_SEPARATOR);
  if (parts.length !== PART_COUNT) return false;
  const [prefix, algorithm, kid, wrapNonce, wrappedDek, wrapTag, nonce, , tag] = parts;
  if (prefix !== PREFIX || algorithm !== ALGORITHM) return false;
  const widths: ReadonlyArray<[string | undefined, number]> = [
    [kid, KID_BYTES],
    [wrapNonce, NONCE_BYTES],
    [wrappedDek, DEK_BYTES],
    [wrapTag, TAG_BYTES],
    [nonce, NONCE_BYTES],
    [tag, TAG_BYTES],
  ];
  for (const [part, expected] of widths) {
    if (part === undefined) return false;
    try {
      decode(part, expected);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Build a vault around an explicit KEK. Tests use this; production goes
 * through {@link credentialVault} so exactly one place reads the environment.
 */
export function createCredentialVault(kek: Uint8Array): CredentialVault {
  if (kek.length !== KEK_BYTES) throw new CredentialVaultError("invalid_key_length");
  const key = Buffer.from(kek);
  const kid = keyId(key);

  function seal(plaintext: string): SealedCredentialSecret {
    if (looksSealed(plaintext)) throw new CredentialVaultError("already_sealed");
    const dek = randomBytes(DEK_BYTES);
    try {
      const wrapNonce = randomBytes(NONCE_BYTES);
      const wrapper = createCipheriv(NODE_CIPHER, key, wrapNonce);
      wrapper.setAAD(aad(kid, "dek"));
      const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
      const wrapTag = wrapper.getAuthTag();

      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(NODE_CIPHER, dek, nonce);
      cipher.setAAD(aad(kid, "payload"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      // The one mint site for the brand. Everything downstream must go through
      // `open` to see a string again.
      return [
        PREFIX,
        ALGORITHM,
        kid,
        encode(wrapNonce),
        encode(wrappedDek),
        encode(wrapTag),
        encode(nonce),
        encode(ciphertext),
        encode(tag),
      ].join(PART_SEPARATOR) as unknown as SealedCredentialSecret;
    } finally {
      // `createCipheriv` copies the key, so the DEK is no longer needed. Best
      // effort — it does not defend a heap dump taken mid-call.
      dek.fill(0);
    }
  }

  function open(persisted: unknown): string {
    if (typeof persisted !== "string") throw new CredentialVaultError("not_a_string");
    const parts = persisted.split(PART_SEPARATOR);
    if (parts.length !== PART_COUNT) throw new CredentialVaultError("malformed_envelope");
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
    if (prefix !== PREFIX) throw new CredentialVaultError("unsupported_version");
    if (algorithm !== ALGORITHM) throw new CredentialVaultError("unsupported_algorithm");
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
    decode(envelopeKid, KID_BYTES);
    if (envelopeKid !== kid) throw new CredentialVaultError("unknown_key");

    const wrapNonce = decode(rawWrapNonce, NONCE_BYTES);
    const wrappedDek = decode(rawWrappedDek, DEK_BYTES);
    const wrapTag = decode(rawWrapTag, TAG_BYTES);
    const nonce = decode(rawNonce, NONCE_BYTES);
    const ciphertext = decode(rawCiphertext);
    const tag = decode(rawTag, TAG_BYTES);

    let dek: Buffer | undefined;
    try {
      const unwrapper = createDecipheriv(NODE_CIPHER, key, wrapNonce);
      unwrapper.setAAD(aad(kid, "dek"));
      unwrapper.setAuthTag(wrapTag);
      dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()]);
      if (dek.length !== DEK_BYTES) throw new CredentialVaultError("malformed_envelope");

      const decipher = createDecipheriv(NODE_CIPHER, dek, nonce);
      decipher.setAAD(aad(kid, "payload"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (err) {
      // A GCM tag mismatch throws a generic `Error` whose message varies by
      // Node version. Collapse everything to one redacted failure so a caller
      // cannot distinguish "wrong key" from "edited ciphertext" from a log line.
      if (err instanceof CredentialVaultError) throw err;
      throw new CredentialVaultError("authentication_failed");
    } finally {
      dek?.fill(0);
    }
  }

  function isSealed(persisted: unknown): persisted is SealedCredentialSecret {
    return looksSealed(persisted);
  }

  return { seal, open, isSealed };
}

let _vault: CredentialVault | undefined;

/**
 * The production vault. Reads `OAUTH_CREDENTIAL_KEK` once and caches the
 * result, so a running process holds one key schedule rather than re-deriving
 * one per credential read.
 *
 * Requiredness has exactly one owner, and it is not this function:
 * `serverEnvSchema` requires `OAUTH_CREDENTIAL_KEK` in every environment and
 * validates its decoded length, so by the time any caller gets here the key
 * exists and is 32 bytes. There is deliberately no derived default and no
 * plaintext fallback — a missing KEK stops the process at env validation, which
 * is loud and one command from fixed, rather than at the first sign-in.
 */
export function credentialVault(): CredentialVault {
  if (_vault) return _vault;
  _vault = createCredentialVault(Buffer.from(serverEnv().OAUTH_CREDENTIAL_KEK, "base64url"));
  return _vault;
}

/** Test seam: drop the cached production vault. */
export function resetCredentialVaultForTest(): void {
  _vault = undefined;
}

export interface CredentialBackfillResult {
  accountsUpdated: number;
  integrationsUpdated: number;
  /** Non-null token fields still readable as plaintext once the pass finishes. */
  plaintextRemaining: number;
  /**
   * Non-null token fields that are envelope-shaped but do **not** open with the
   * configured key — a wrong or already-rotated `OAUTH_CREDENTIAL_KEK`. Counted
   * separately from `plaintextRemaining` because the operator action differs:
   * plaintext needs the conversion pass, an unopenable envelope needs the right
   * key (or a rewrap under the old one). Folding the two would hand the
   * operator the wrong diagnosis.
   */
  unopenableRemaining: number;
}

/**
 * The five columns that hold a bearer or refresh capability.
 *
 * `ACCOUNT_SECRET_FIELDS` is exported because two boundaries must agree on it
 * exactly: `encryptedAuthAdapter` in `@alfred/auth` seals and opens these fields,
 * and the boot gate below refuses to start unless every one of them is sealed. A
 * field the adapter seals but the gate does not check leaves a column nothing
 * verifies; a field the gate checks but the adapter does not seal makes the
 * process refuse to boot forever. One tuple, owned here beside the rest of the
 * column catalog, is what keeps the two lists from drifting.
 */
export const ACCOUNT_SECRET_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;
export type AccountSecretField = (typeof ACCOUNT_SECRET_FIELDS)[number];
const INTEGRATION_SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

/**
 * What a persisted non-null token value actually is, from this process's point
 * of view. `isSealed` alone cannot answer this: it is a shape test that ignores
 * `kid` deliberately, so a row sealed under a *different* KEK looks identical to
 * one this process can read. Every caller below needs the stronger question, so
 * the classification attempts the decryption. The plaintext it recovers is
 * discarded immediately and never leaves this function.
 */
type PersistedTokenState =
  | { readonly state: "absent" }
  | { readonly state: "plaintext"; readonly plaintext: string }
  | { readonly state: "openable" }
  | { readonly state: "unopenable" };

/**
 * The value arrives as `unknown` on purpose. `integration_credentials` types its
 * token columns {@link SealedCredentialSecret}, and this pass exists precisely
 * for the rows where that claim is not yet true, so the column type is the one
 * thing it must not believe. The `plaintext` arm carries the narrowed string, so
 * the caller seals a value this function already validated rather than
 * re-deriving it.
 */
function classifyPersisted(value: unknown, vault: CredentialVault): PersistedTokenState {
  if (value === null || value === undefined) return { state: "absent" };
  // A `text` column cannot hold a non-string, so this arm is unreachable in
  // practice. It answers `unopenable` rather than `plaintext` so an impossible
  // value fails the gate closed instead of being handed to `seal`.
  if (typeof value !== "string") return { state: "unopenable" };
  if (!vault.isSealed(value)) return { state: "plaintext", plaintext: value };
  try {
    vault.open(value);
    return { state: "openable" };
  } catch {
    return { state: "unopenable" };
  }
}

/**
 * Plan the conversion of one row: seal what is plaintext, leave what already
 * opens, and refuse the rest. An envelope this key cannot open must not be
 * counted as done — that is how a rotation half-applies — and it cannot be
 * rewrapped here either, because the pass holds only the new key. Throwing
 * inside the transaction rolls the whole run back.
 */
function sealPending<Field extends string>(
  row: Readonly<Record<Field, unknown>>,
  fields: readonly Field[],
  vault: CredentialVault,
): Partial<Record<Field, SealedCredentialSecret>> {
  const pending: Partial<Record<Field, SealedCredentialSecret>> = {};
  for (const field of fields) {
    const classified = classifyPersisted(row[field], vault);
    if (classified.state === "absent" || classified.state === "openable") continue;
    if (classified.state === "unopenable") {
      throw new CredentialVaultError(
        "unopenable_remaining",
        "a persisted envelope does not open with the configured OAUTH_CREDENTIAL_KEK — this pass converts plaintext, it cannot rewrap another key's envelope",
      );
    }
    pending[field] = vault.seal(classified.plaintext);
  }
  return pending;
}

/**
 * The same map, typed for `account`'s unbranded columns.
 *
 * `SealedCredentialSecret` is not assignable to `string`, which is the whole
 * point of the brand — but Better Auth owns `account`'s payload types, so those
 * Drizzle columns stay plain `text` (the schema docblock records the asymmetry)
 * and an update there needs the text back. File-private on purpose: `open` is
 * the only public way out of the brand.
 */
function asUnbranded<Field extends string>(
  pending: Partial<Record<Field, SealedCredentialSecret>>,
): Partial<Record<Field, string>> {
  return pending as unknown as Partial<Record<Field, string>>;
}

function countUnsealed<Field extends string>(
  row: Readonly<Record<Field, unknown>>,
  fields: readonly Field[],
  vault: CredentialVault,
): { plaintext: number; unopenable: number } {
  let plaintext = 0;
  let unopenable = 0;
  for (const field of fields) {
    const { state } = classifyPersisted(row[field], vault);
    if (state === "plaintext") plaintext += 1;
    else if (state === "unopenable") unopenable += 1;
  }
  return { plaintext, unopenable };
}

/**
 * One-time, idempotent conversion of the existing plaintext rows (#453), plus
 * the check that proves it finished.
 *
 * **Run this only with every writer stopped.** It is an in-place
 * representation change in columns a running old process still reads as
 * plaintext — that process would send an envelope to Google as a bearer token,
 * or rewrite a token in plaintext after the check passed. The whole pass is one
 * transaction, so a malformed row rolls the run back rather than leaving the
 * table half-converted.
 *
 * It converts plaintext and nothing else. An envelope that does not open with
 * the configured key aborts the run instead of being skipped as "already done";
 * rewrapping one key's envelope under another is a separate operation that
 * needs both keys. See
 * `docs/runbooks/oauth-credential-vault-rollout.md`.
 */
export async function encryptPersistedOAuthCredentials(options?: {
  checkOnly?: boolean;
}): Promise<CredentialBackfillResult> {
  const checkOnly = options?.checkOnly === true;
  const vault = credentialVault();

  return db().transaction(async (tx) => {
    let accountsUpdated = 0;
    let integrationsUpdated = 0;

    // The check mode plans nothing: sealing a value only to discard it would
    // burn entropy and, worse, would make the check throw on the rotation case
    // it exists to report.
    if (!checkOnly) {
      const accountRows = await tx
        .select({
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
        })
        .from(account);
      for (const row of accountRows) {
        const pending = sealPending(row, ACCOUNT_SECRET_FIELDS, vault);
        if (Object.keys(pending).length === 0) continue;
        await tx.update(account).set(asUnbranded(pending)).where(eq(account.id, row.id));
        accountsUpdated += 1;
      }

      const integrationRows = await tx
        .select({
          id: integrationCredentials.id,
          accessToken: integrationCredentials.accessToken,
          refreshToken: integrationCredentials.refreshToken,
        })
        .from(integrationCredentials);
      for (const row of integrationRows) {
        const pending = sealPending(row, INTEGRATION_SECRET_FIELDS, vault);
        if (Object.keys(pending).length === 0) continue;
        await tx
          .update(integrationCredentials)
          .set(pending)
          .where(eq(integrationCredentials.id, row.id));
        integrationsUpdated += 1;
      }
    }

    // Re-read rather than trusting the counters: the point of this number is to
    // catch a row the pass did not see, so counting what the pass wrote proves
    // nothing.
    const verifyAccounts = await tx
      .select({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
      })
      .from(account);
    const verifyIntegrations = await tx
      .select({
        accessToken: integrationCredentials.accessToken,
        refreshToken: integrationCredentials.refreshToken,
      })
      .from(integrationCredentials);
    let plaintextRemaining = 0;
    let unopenableRemaining = 0;
    for (const row of verifyAccounts) {
      const counts = countUnsealed(row, ACCOUNT_SECRET_FIELDS, vault);
      plaintextRemaining += counts.plaintext;
      unopenableRemaining += counts.unopenable;
    }
    for (const row of verifyIntegrations) {
      const counts = countUnsealed(row, INTEGRATION_SECRET_FIELDS, vault);
      plaintextRemaining += counts.plaintext;
      unopenableRemaining += counts.unopenable;
    }

    return { accountsUpdated, integrationsUpdated, plaintextRemaining, unopenableRemaining };
  });
}

/**
 * Boot gate. A process that starts against a half-converted table would serve
 * traffic that throws on every credential read, and would rewrite plaintext
 * behind the operator's back. Fail the boot instead.
 *
 * It gates on openability, not on envelope shape. Shape alone would pass a
 * table sealed under a wrong or already-swapped key — every row looks right,
 * `plaintextRemaining` is 0, and then every credential read throws at request
 * time, which is precisely the outcome this gate exists to prevent.
 */
export async function assertPersistedCredentialsSealed(): Promise<void> {
  const { plaintextRemaining, unopenableRemaining } = await encryptPersistedOAuthCredentials({
    checkOnly: true,
  });
  if (plaintextRemaining > 0) {
    throw new CredentialVaultError(
      "plaintext_remaining",
      `${plaintextRemaining} token field(s) are not sealed — run the backfill with all writers stopped`,
    );
  }
  if (unopenableRemaining > 0) {
    throw new CredentialVaultError(
      "unopenable_remaining",
      `${unopenableRemaining} sealed token field(s) do not open with the configured OAUTH_CREDENTIAL_KEK — the key is wrong, or a rotation rewrap did not run`,
    );
  }
}
