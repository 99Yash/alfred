import { canonicalJson } from "@alfred/contracts";
import { createHash } from "node:crypto";

/**
 * `sha256:` hash of the key-sorted JSON, so equal values always hash the same.
 * Lives here, not in `@alfred/contracts`, because it needs `node:crypto`.
 */
export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
