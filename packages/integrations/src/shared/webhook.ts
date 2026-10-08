import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare. The caller strips any prefix (GitHub `sha256=`).
 * A missing header is a mismatch, not an exception.
 */
export function signatureMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);

  return a.length === b.length && timingSafeEqual(a, b);
}

/** HMAC-SHA256 hex over the exact body. */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
