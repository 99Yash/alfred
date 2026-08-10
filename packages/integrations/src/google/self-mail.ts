import { parseEmailAddress } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";

/**
 * Alfred self-mail identity. Pure identity helpers — no `documents` /
 * `ingestion_state` writes and no corpus indexing — so they stay in the
 * provider package after the ingestion orchestration moved to the api-layer
 * consumer (`@alfred/assistant` `connections/ingestion/gmail-ingest.ts`). Both the
 * consumer's persist path and downstream self-mail retirement/label backfills
 * plus the drift-audit metrics read them through `@alfred/integrations/google`.
 */

/**
 * Alfred's own send identity, parsed from `RESEND_FROM_EMAIL` (e.g.
 * `"Alfred <hey@alfred.beauty>"`) — the single source of truth shared with
 * `@alfred/mailer`. Lazily resolved + cached for the process.
 */
let _selfSenderEmail: string | null | undefined;
export function selfSenderEmail(): string | null {
  if (_selfSenderEmail === undefined) {
    _selfSenderEmail = parseEmailAddress(serverEnv().RESEND_FROM_EMAIL);
  }
  return _selfSenderEmail;
}

/**
 * True when a message was sent by Alfred itself (briefing / approval mail,
 * `From` = `RESEND_FROM_EMAIL`). Alfred's outbound re-enters the connected
 * inbox as ordinary *inbound* mail — it carries no Gmail `SENT` label, so the
 * `isSent` guard never catches it. Left un-filtered it gets ingested, triaged
 * into the demanding lanes, and re-fed into the next briefing: a self-
 * amplifying loop (issue #211). Self-mail carries no signal Alfred didn't
 * itself author, so we drop it before it becomes a `documents` row.
 */
export function isSelfAuthored(from: string | null): boolean {
  const self = selfSenderEmail();
  return self !== null && parseEmailAddress(from) === self;
}
