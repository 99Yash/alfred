import { parseEmailAddress } from "@alfred/contracts";
import { envFieldValue } from "@alfred/env/server";

/**
 * Alfred's send address, from `RESEND_FROM_EMAIL`. Cached per process.
 * `envFieldValue` returns `null` in a bare test run instead of throwing.
 */
let _selfSenderEmail: string | null | undefined;

export function selfSenderEmail(): string | null {
  if (_selfSenderEmail === undefined) {
    _selfSenderEmail = parseEmailAddress(envFieldValue("RESEND_FROM_EMAIL"));
  }

  return _selfSenderEmail;
}

/**
 * Alfred's own mail comes back as inbound with no `SENT` label. Ingesting it would
 * feed each briefing into the next (#211), so it is dropped before it becomes a document.
 */
export function isSelfAuthored(from: string | null): boolean {
  const self = selfSenderEmail();

  return self !== null && parseEmailAddress(from) === self;
}
