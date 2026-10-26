/**
 * The `GmailSenderParser` port that knowledge depends on (ADR-0089). Injected at
 * the composition root, so knowledge never imports triage.
 * Two `isSent` rules on purpose; never unify them:
 *   - `authorship.isSent`: `isSent` flag OR a `SENT` label.
 *   - `correspondents.isSent`: the flag only. Unifying would flip some received
 *     docs to outbound in the team graph.
 */

import {
  isSentGmailMetadata,
  parseGmailDocumentMetadata,
  parseMailbox,
  splitAddressList,
  type GmailAuthorshipObservation,
  type GmailCorrespondentsObservation,
  type GmailSenderParser,
  type PersonToken,
} from "@alfred/contracts";
import { extractSenderContext, isHumanLikeSender } from "./sender-context";

// ---------------------------------------------------------------------------
// person parsing
// ---------------------------------------------------------------------------

/**
 * One token as a person, or null for service envelopes. A service-domain sender
 * (`jane.doe@google.com`) is rescued by `isHumanLikeSender`.
 */
function parsePersonToken(token: string): PersonToken | null {
  const mailbox = parseMailbox(token);

  if (!mailbox) return null;
  const sc = extractSenderContext({ fromHeader: token, subject: null, body: "" });

  if (
    sc.context.fromKind !== "person" &&
    !isHumanLikeSender(mailbox.localPart, mailbox.displayName)
  ) {
    return null;
  }

  return { address: mailbox.address, domain: mailbox.domain, displayName: mailbox.displayName };
}

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

export const gmailSenderAdapter: GmailSenderParser = {
  authorship(metadata: unknown): GmailAuthorshipObservation {
    const meta = parseGmailDocumentMetadata(metadata);
    const isSent = isSentGmailMetadata(meta);
    const fromRaw = meta.from ?? null;

    const fromEmail = fromRaw
      ? extractSenderContext({ fromHeader: fromRaw, subject: null, body: "" }).senderAddress
      : null;

    return { isSent, fromEmail };
  },

  correspondents(metadata: unknown): GmailCorrespondentsObservation {
    const meta = parseGmailDocumentMetadata(metadata);
    // Flag only, on purpose (see the header).
    const isSent = meta.isSent === true;
    const from = parsePersonToken(meta.from ?? "");
    const recipients: PersonToken[] = [];

    for (const token of [
      ...splitAddressList(meta.to ?? null),
      ...splitAddressList(meta.cc ?? null),
    ]) {
      const p = parsePersonToken(token);

      if (p) recipients.push(p);
    }

    return { isSent, from, recipients };
  },
};
