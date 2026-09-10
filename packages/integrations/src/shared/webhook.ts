import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The wire primitives every inbound webhook descriptor shares: a constant-time
 * signature compare and the HMAC both GitHub and Sentry sign with. The id
 * reader that joins a delivery to its credential is `getIdPath` in
 * `@alfred/contracts`, beside the other JSON leaf readers.
 */

/**
 * Compare a presented webhook signature with the one we expect, in constant
 * time. Both GitHub (`sha256=<hex>`) and Sentry (`<hex>`) sign the RAW request
 * body with HMAC-SHA256 and a shared secret; the prefix is the caller's, the
 * comparison is not. A missing header is a mismatch, never an exception.
 */
export function signatureMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);

  return a.length === b.length && timingSafeEqual(a, b);
}

/** HMAC-SHA256 of the exact body bytes, hex-encoded. The UTF-8 encoding is the one every provider transmits. */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
