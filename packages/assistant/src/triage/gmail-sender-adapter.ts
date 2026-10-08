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
  type GmailAuthorshipObservation,
  type GmailCorrespondentsObservation,
  type GmailSenderParser,
  type PersonToken,
} from "@alfred/contracts";
import { extractSenderContext, isHumanLikeSender } from "./sender-context";

// ---------------------------------------------------------------------------
// header splitting / person parsing
// ---------------------------------------------------------------------------

/** Split To/Cc, honoring quotes and angle brackets (`"Doe, Jane" <j@x.com>`). */
export function splitAddressList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;

  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;

    if (ch === "," && !inQuote && !inAngle) {
      const t = buf.trim();

      if (t) out.push(t);
      buf = "";
      continue;
    }

    buf += ch;
  }

  const last = buf.trim();

  if (last) out.push(last);

  return out;
}

const ANGLE_NAME_RE = /^(.*?)<[^>]+>\s*$/;

function parseDisplayName(token: string): string | null {
  const m = token.trim().match(ANGLE_NAME_RE);

  if (!m || m[1] === undefined) return null;

  const name = m[1]
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim();

  return name || null;
}

/**
 * One token as a person, or null for service envelopes. A service-domain sender
 * (`jane.doe@google.com`) is rescued by `isHumanLikeSender`.
 */
function parsePersonToken(token: string): PersonToken | null {
  const sc = extractSenderContext({ fromHeader: token, subject: null, body: "" });

  if (!sc.senderAddress) return null;
  const displayName = parseDisplayName(token);

  if (sc.context.fromKind !== "person") {
    const localPart = sc.senderAddress.slice(0, sc.senderAddress.indexOf("@"));

    if (!isHumanLikeSender(localPart, displayName)) return null;
  }

  return {
    address: sc.senderAddress,
    domain: sc.senderDomain,
    displayName,
  };
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
