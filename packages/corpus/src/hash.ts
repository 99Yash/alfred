import { createHash } from "node:crypto";

/** SHA-256 hex digest — single owner for contentHash across ingest and corpus. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
