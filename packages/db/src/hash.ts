import { canonicalJson } from "@alfred/contracts";
import { createHash } from "node:crypto";

// The owner of every exported hash helper (`alfred/no-exported-hasher`, owner list in
// scripts/oxlint/alfred/shared/hash-owners.ts). Lives here, not in `@alfred/contracts`,
// because it needs `node:crypto`.

/**
 * SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters, with no
 * prefix. For raw text: a document body, a key, a prompt. A structured value goes
 * through {@link sha256Canonical} instead, because `JSON.stringify` output depends
 * on key order.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `sha256:` hash of the key-sorted JSON, so equal values always hash the same. */
export function sha256Canonical(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
