import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";

import {
  createCredentialVault,
  CredentialVaultError,
  type CredentialVaultFailure,
} from "@alfred/db/credential-vault";

/**
 * Unit coverage for the credential envelope (#453). Keys are injected, so
 * nothing here needs `OAUTH_CREDENTIAL_KEK`, a database, or a network.
 */

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const vault = createCredentialVault(KEY);

/** Assert a call fails with a specific redacted failure kind. */
function assertFailure(fn: () => unknown, failure: CredentialVaultFailure, secret?: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CredentialVaultError, `expected CredentialVaultError, got ${err}`);
    assert.equal(err.failure, failure);
    if (secret !== undefined) {
      assert.ok(
        !err.message.includes(secret),
        "the error message must never quote the value it rejected",
      );
    }
    return;
  }
  assert.fail(`expected ${failure}`);
}

/** Swap one part of the dot-separated envelope. */
function replacePart(envelope: string, index: number, value: string): string {
  const parts = envelope.split(".");
  parts[index] = value;
  return parts.join(".");
}

/** Flip a bit inside a base64url part so it decodes to the same length. */
function corruptPart(envelope: string, index: number): string {
  const parts = envelope.split(".");
  const bytes = Buffer.from(parts[index] ?? "", "base64url");
  assert.ok(bytes.length > 0, "cannot corrupt an empty part");
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return replacePart(envelope, index, bytes.toString("base64url"));
}

const PART = {
  prefix: 0,
  algorithm: 1,
  kid: 2,
  wrapNonce: 3,
  wrappedDek: 4,
  wrapTag: 5,
  nonce: 6,
  ciphertext: 7,
  tag: 8,
} as const;

describe("credential vault: key construction", () => {
  test("rejects a key that is not 32 bytes", () => {
    for (const length of [0, 16, 31, 33, 64]) {
      assertFailure(() => createCredentialVault(randomBytes(length)), "invalid_key_length");
    }
  });
});

describe("credential vault: round trip", () => {
  test("recovers the exact plaintext for empty, short, and large tokens", () => {
    const cases = [
      "",
      "x",
      "ya29.a0AfH6SMBshortish-google-token",
      "gho_" + "a".repeat(36),
      // Refresh tokens and id_tokens are the long end of the real range.
      "eyJhbGciOiJSUzI1NiJ9." + "b".repeat(4096) + ".sig",
      // Multi-byte input must survive the utf8 round trip.
      "tökén-🔐-値",
    ];
    for (const plaintext of cases) {
      assert.equal(vault.open(vault.seal(plaintext)), plaintext);
    }
  });

  test("two seals of one plaintext differ", () => {
    const plaintext = "ya29.identical-input";
    const first = vault.seal(plaintext);
    const second = vault.seal(plaintext);
    assert.notEqual(first, second, "a deterministic envelope would leak equality of tokens");
    assert.equal(vault.open(first), plaintext);
    assert.equal(vault.open(second), plaintext);
  });

  test("the serialized envelope holds neither the plaintext nor a readable key", () => {
    const plaintext = "ya29.super-secret-access-token";
    const envelope = vault.seal(plaintext);
    assert.ok(!envelope.includes(plaintext));
    assert.ok(!envelope.includes("super-secret"));
    // The kid is a truncated hash of the KEK, so the KEK itself must not appear
    // in the same alphabet the envelope is written in.
    assert.ok(!envelope.includes(KEY.toString("base64url")));
  });

  test("the envelope declares its version and algorithm", () => {
    const parts = vault.seal("token").split(".");
    assert.equal(parts.length, 9);
    assert.equal(parts[PART.prefix], "acv1");
    assert.equal(parts[PART.algorithm], "A256GCM");
  });

  test("seal refuses current, future, and damaged envelope-family values", () => {
    const envelope = vault.seal("token");
    assertFailure(() => vault.seal(envelope), "already_sealed");
    assertFailure(
      () => vault.seal(`acv2.${envelope.split(".").slice(1).join(".")}`),
      "already_sealed",
    );
    assertFailure(
      () => vault.seal(`acv0.${envelope.split(".").slice(1).join(".")}`),
      "already_sealed",
    );
    assertFailure(() => vault.seal("acv1.damaged"), "already_sealed");
  });
});

describe("credential vault: open fails closed", () => {
  const envelope = vault.seal("ya29.the-real-token");

  test("rejects plaintext", () => {
    // The rollout's whole risk is a row the backfill missed. It must throw, not
    // pass the token through.
    assertFailure(() => vault.open("ya29.plain-token"), "malformed_envelope");
    assertFailure(() => vault.open(""), "malformed_envelope");
  });

  test("rejects non-strings", () => {
    for (const value of [null, undefined, 42, {}, [], Buffer.from("x")]) {
      assertFailure(() => vault.open(value), "not_a_string");
    }
  });

  test("rejects a wrong part count", () => {
    assertFailure(() => vault.open(`${envelope}.extra`), "malformed_envelope");
    assertFailure(
      () => vault.open(envelope.split(".").slice(0, 8).join(".")),
      "malformed_envelope",
    );
  });

  test("rejects an unsupported version or algorithm", () => {
    assertFailure(
      () => vault.open(replacePart(envelope, PART.prefix, "acv2")),
      "unsupported_version",
    );
    assertFailure(
      () => vault.open(replacePart(envelope, PART.algorithm, "A128GCM")),
      "unsupported_algorithm",
    );
  });

  test("rejects a wrong key", () => {
    const other = createCredentialVault(OTHER_KEY);
    // The key id is derived from the KEK, so a foreign key is named as such
    // rather than surfacing as a generic tag failure.
    assertFailure(() => other.open(envelope), "unknown_key");
    assert.equal(other.open(other.seal("mine")), "mine");
  });

  test("rejects a tampered wrapped DEK, payload, nonce, or tag", () => {
    for (const part of [
      PART.wrappedDek,
      PART.wrapTag,
      PART.wrapNonce,
      PART.ciphertext,
      PART.tag,
      PART.nonce,
    ]) {
      assertFailure(() => vault.open(corruptPart(envelope, part)), "authentication_failed");
    }
  });

  test("rejects a tampered key id", () => {
    assertFailure(() => vault.open(corruptPart(envelope, PART.kid)), "unknown_key");
  });

  test("rejects truncated fixed-width fields", () => {
    for (const part of [
      PART.kid,
      PART.wrapNonce,
      PART.wrappedDek,
      PART.wrapTag,
      PART.nonce,
      PART.tag,
    ]) {
      const parts = envelope.split(".");
      const truncated = Buffer.from(parts[part] ?? "", "base64url").subarray(0, 4);
      assertFailure(
        () => vault.open(replacePart(envelope, part, truncated.toString("base64url"))),
        "malformed_envelope",
      );
    }
  });

  test("rejects malformed base64", () => {
    for (const bad of ["not base64!", "++//==", "%%%%"]) {
      assertFailure(
        () => vault.open(replacePart(envelope, PART.ciphertext, bad)),
        "malformed_envelope",
      );
    }
  });

  test("never quotes the rejected value", () => {
    const secret = "ya29.leaked-into-a-log-line";
    assertFailure(() => vault.open(secret), "malformed_envelope", secret);
  });

  test("cross-role substitution fails", () => {
    // The wrapped DEK and the payload use distinct AAD, so a payload fed to the
    // unwrap step (or the reverse) cannot be interpreted.
    const parts = envelope.split(".");
    const swapped = [...parts];
    swapped[PART.wrapNonce] = parts[PART.nonce] ?? "";
    swapped[PART.nonce] = parts[PART.wrapNonce] ?? "";
    assertFailure(() => vault.open(swapped.join(".")), "authentication_failed");
  });
});

describe("credential vault: isSealed", () => {
  test("recognizes the envelope family without claiming it is openable", () => {
    assert.equal(vault.isSealed(vault.seal("token")), true);
    // A foreign key's envelope is still an envelope — the shape test is
    // deliberately not an authorization check.
    assert.equal(vault.isSealed(createCredentialVault(OTHER_KEY).seal("token")), true);
    assert.equal(vault.isSealed("acv1.A256GCM.short.a.b.c.d.e.f"), true);
    assert.equal(
      vault.isSealed(`acv2.A256GCM.${vault.seal("t").split(".").slice(2).join(".")}`),
      true,
    );
    assert.equal(vault.isSealed("acv0.damaged"), true);

    for (const value of [
      "ya29.plain-token",
      "",
      null,
      undefined,
      42,
      {},
      // A JWT is the closest real token shape; it must not read as sealed.
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    ]) {
      assert.equal(vault.isSealed(value), false, `isSealed should reject ${String(value)}`);
    }
  });
});
