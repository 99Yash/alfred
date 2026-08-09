/**
 * Gmail sender parser ADAPTER (campaign knowledge-settings-phase4 item 04,
 * ADR-0089).
 *
 * The concrete `GmailSenderParser` port `knowledge` (formerly `memory`) depends
 * on. Memory's fact-policy and team-graph used to import triage's `From:`/SENT
 * parsers directly — the `memory ↔ triage` cycle. That parse now lives here,
 * triage-owned, and the composition roots inject `gmailSenderAdapter` into
 * memory so no `memory → triage` edge exists.
 *
 * Nothing here changes what the parsers decide: it wraps `extractSenderContext`
 * / `isSentGmailMetadata` / `isHumanLikeSender` and the header splitters
 * relocated from `memory/team-graph.ts` (byte-identical logic), and hands memory
 * a normalized observation. Triage-owned; imports only triage + contracts.
 *
 * Two `isSent` derivations are deliberate and MUST NOT be unified:
 *   - `authorship.isSent` = `isSentGmailMetadata` (`isSent===true` OR a `"SENT"`
 *     labelId),
 *   - `correspondents.isSent` = `meta.isSent === true` only (ignores labelIds).
 * Unifying them would flip a SENT-labelId-only received doc from inbound to
 * outbound in the team graph — the quirk the campaign-04 seam test pins.
 */

import {
  isRecord,
  type GmailAuthorshipObservation,
  type GmailCorrespondentsObservation,
  type GmailSenderParser,
  type PersonToken,
} from "@alfred/contracts";
import { extractSenderContext, isHumanLikeSender } from "./sender-context";
import { isSentGmailMetadata } from "./sent-mail";

// ---------------------------------------------------------------------------
// header splitting / person parsing (relocated from memory/team-graph.ts)
// ---------------------------------------------------------------------------

/** First non-empty string value at `key` in `meta`, else null. */
function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Split a `To:`/`Cc:` header into individual address tokens. Commas inside a
 * quoted display name (`"Doe, Jane" <j@x.com>`) or inside angle brackets are
 * not separators, so a naive `split(',')` corrupts those — track quote/angle
 * depth instead.
 */
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

/** Extract just the display-name part of a `Name <addr>` token (null if bare address). */
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
 * Parse one header token into a *person* contact, reusing triage's curated
 * sender classification so `noreply`/role/service envelopes are dropped here
 * (returns `null`). Address/domain come from `extractSenderContext` (the
 * authoritative normalizer); only the display name is parsed locally.
 *
 * Triage classifies whole service domains (`google.com`, `github.com`, …) as
 * `service`, which would silently drop a real colleague at one of them. The
 * graph wants the human, so a non-`person` sender is rescued when it passes the
 * `isHumanLikeSender` reality check (person-like name or `first.last` local, and
 * not an automated envelope) — see that helper for why triage itself is left
 * untouched.
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
    const meta = isRecord(metadata) ? metadata : null;
    // labelId-aware SENT signal (diverges from `correspondents.isSent`).
    const isSent = isSentGmailMetadata(meta);
    const fromRaw = meta && typeof meta.from === "string" ? meta.from : null;
    const fromEmail = fromRaw
      ? extractSenderContext({ fromHeader: fromRaw, subject: null, body: "" }).senderAddress
      : null;
    return { isSent, fromEmail };
  },

  correspondents(metadata: unknown): GmailCorrespondentsObservation {
    const meta = isRecord(metadata) ? metadata : {};
    // `meta.isSent === true` ONLY — labelIds intentionally ignored here.
    const isSent = meta.isSent === true;
    const from = parsePersonToken(metaStr(meta, "from") ?? "");
    const recipients: PersonToken[] = [];
    for (const token of [
      ...splitAddressList(metaStr(meta, "to")),
      ...splitAddressList(metaStr(meta, "cc")),
    ]) {
      const p = parsePersonToken(token);
      if (p) recipients.push(p);
    }
    return { isSent, from, recipients };
  },
};
