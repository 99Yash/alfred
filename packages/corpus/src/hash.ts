import { createHash } from "node:crypto";

/** SHA-256 hex digest. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
