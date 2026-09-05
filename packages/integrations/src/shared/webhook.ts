import { getPath, isNonEmptyString, type JsonObject } from "@alfred/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The wire primitives every inbound webhook descriptor shares: a constant-time
 * signature compare, the HMAC both GitHub and Sentry sign with, and the id
 * reader that joins a delivery to the credential that owns it.
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

/**
 * A provider id at `keys` in a webhook payload, as `integration_credentials.installation_id`
 * and the dedup key store it. Providers serialize ids both ways (GitHub's
 * `installation.id` and Sentry's `data.run_id` are integers; Sentry's
 * `issue.id` and `event_id` are strings), so both spellings collapse to one
 * string and no key or join depends on which. `null` when absent or empty.
 */
export function payloadIdAt(payload: JsonObject, ...keys: string[]): string | null {
  const leaf = getPath(payload, ...keys);
  if (isNonEmptyString(leaf)) return leaf;
  if (typeof leaf === "number" && Number.isSafeInteger(leaf)) return String(leaf);
  return null;
}
