import { type SenderContext } from "@alfred/contracts";
import type { SenderPrior } from "./sender-priors";
import type { ThreadState } from "./thread-state";

/**
 * Deterministic observation layer (ADR-0051 #4a). PURE — zero IO, zero LLM.
 * Assembles the pre-model context fed into the single cheap classify call:
 * sender prior histogram, account persona, thread state, known-contact flag,
 * Gmail-native signals, and cheap regex content flags.
 *
 * The mechanism that makes a cheap model smart is *focused attention*, not a
 * bigger model — so this layer's whole job is to surface anomalies (a security
 * keyword in mail from a 99%-newsletter sender) the model would otherwise miss.
 *
 * Phase 2 builds + snapshot-tests this assembler; Phase 3 wires its output
 * into the classifier prompt and the inconsistency checker. Keeping it pure
 * means the wiring is a prompt change, not a re-architecture.
 */

// ---------------------------------------------------------------------------
// Gmail-native signals
// ---------------------------------------------------------------------------

export interface GmailSignals {
  /** Gmail's own inbox categories present on the message (`primary`, `promotions`, …). */
  categories: string[];
  important: boolean;
  starred: boolean;
  inInbox: boolean;
}

const GMAIL_CATEGORY_PREFIX = "CATEGORY_";

/** Map raw Gmail `labelIds` to the bounded signal set the model can use. */
export function extractGmailSignals(labelIds: readonly string[]): GmailSignals {
  const categories: string[] = [];
  let important = false;
  let starred = false;
  let inInbox = false;
  for (const id of labelIds) {
    if (id.startsWith(GMAIL_CATEGORY_PREFIX)) {
      categories.push(id.slice(GMAIL_CATEGORY_PREFIX.length).toLowerCase());
    } else if (id === "IMPORTANT") important = true;
    else if (id === "STARRED") starred = true;
    else if (id === "INBOX") inInbox = true;
  }
  categories.sort(); // stable order for snapshot tests
  return { categories, important, starred, inInbox };
}

// ---------------------------------------------------------------------------
// Content flags (cheap regex)
// ---------------------------------------------------------------------------

export interface ContentFlags {
  /** A bulk-mail unsubscribe footer — a strong newsletter/marketing tell. */
  hasUnsubscribe: boolean;
  /** A currency amount (`$1,200.00`, `₹500`, `1.000,00 €`) — a payment tell. */
  hasCurrencyAmount: boolean;
  /**
   * Security/credential vocabulary — broad on purpose (matches sign-in /
   * password / token language). Feeds the model AND the second-pass
   * under-classification net. This is STRICTLY BROADER than the override-floor
   * predicate (which keys on exposure verbs only), so a self-initiated magic
   * link sets this flag but never trips the floor.
   */
  hasSecurityKeyword: boolean;
  /** An embedded calendar invite (iCal) — a meeting tell. */
  hasCalendarInvite: boolean;
  /**
   * Investor / shareholder / AGM / registrar notice language (ADR-0051 §5,
   * Phase 3). Migrated from the deleted `applyTriageClassificationGuardrails`
   * investor rewrite — now a NAMED FLAG fed to the model, never a category
   * rewrite. Helps the model honor rule 9 (a corporate "meeting" is not the
   * user's meeting).
   */
  hasInvestorNotice: boolean;
  /**
   * Public-event blast language — WWDC/keynote/webinar/conference/summit/
   * launch/save-the-date (ADR-0051 §5, Phase 3). Migrated from the deleted
   * public-event guardrail; a named flag, not a rewrite. Helps the model
   * honor rule 8 (public events are marketing/newsletter/fyi, not meeting).
   */
  hasPublicEventLanguage: boolean;
}

const UNSUBSCRIBE_RE = /\bunsubscribe\b|\bmanage (your )?preferences\b|list-unsubscribe/i;
const CURRENCY_RE =
  /(?:[$€£₹]\s?\d|(?:\b(?:usd|eur|gbp|inr)\b)\s?\d|\d[\d.,]*\s?(?:[$€£₹]|usd|eur|gbp|inr)\b)/i;
const SECURITY_RE =
  /\bcve-\d{4}-\d+\b|\b(?:exposed|leaked|compromised)\b|\b(?:secret|credential|api[ -]?key|token|private key|password)\b|\b(?:unauthorized|suspicious) (?:sign-?in|login|access)\b/i;
const CALENDAR_RE = /BEGIN:VCALENDAR|BEGIN:VEVENT|\bical\b|text\/calendar/i;
const INVESTOR_RE =
  /\bannual general meeting\b|\bagm\b|\bshareholder(?:s)?\b|\bproxy\b|\be-?voting\b|\bevoting\b|\bannual report\b|\bregistrar\b|\bdepository\b|\bnsdl\b|\bcdsl\b/i;
const PUBLIC_EVENT_RE =
  /\bwwdc\d*\b|\bkeynote\b|\bwebinar\b|\bconference\b|\bsummit\b|\bproduct launch\b|\blaunch event\b|\bpublic event\b|\bsave the date\b/i;

/** Derive cheap deterministic content flags from the email's signal text. */
export function extractContentFlags(text: string): ContentFlags {
  return {
    hasUnsubscribe: UNSUBSCRIBE_RE.test(text),
    hasCurrencyAmount: CURRENCY_RE.test(text),
    hasSecurityKeyword: SECURITY_RE.test(text),
    hasCalendarInvite: CALENDAR_RE.test(text),
    hasInvestorNotice: INVESTOR_RE.test(text),
    hasPublicEventLanguage: PUBLIC_EVENT_RE.test(text),
  };
}

// ---------------------------------------------------------------------------
// Assembled observations
// ---------------------------------------------------------------------------

export interface Observations {
  senderPrior: {
    key: string | null;
    /** Histogram — empty object when this sender has no prior (or is a human/skip). */
    categoryCounts: Record<string, number>;
    lastCategory: string | null;
  };
  /** `'work' | 'personal' | null` — null until detected on the credential. */
  persona: string | null;
  thread: ThreadState;
  /** The sender is a known contact in the user's entity graph. */
  knownContact: boolean;
  gmail: GmailSignals;
  content: ContentFlags;
}

export interface AssembleObservationsArgs {
  senderContext: Pick<SenderContext, "effectiveAuthor" | "botSlug">;
  senderKey: string | null;
  senderPrior: SenderPrior | null;
  persona: string | null;
  thread: ThreadState;
  knownContact: boolean;
  labelIds: readonly string[];
  /** Concatenated signal text (subject + body + headers), lowercased or not. */
  signalText: string;
}

/**
 * Assemble the full observation object. Pure and order-stable so it can be
 * snapshot-tested and diffed in the `triage.sender_extraction` log.
 */
export function assembleObservations(args: AssembleObservationsArgs): Observations {
  return {
    senderPrior: {
      key: args.senderKey,
      categoryCounts: args.senderPrior?.categoryCounts ?? {},
      lastCategory: args.senderPrior?.lastCategory ?? null,
    },
    persona: args.persona,
    thread: args.thread,
    knownContact: args.knownContact,
    gmail: extractGmailSignals(args.labelIds),
    content: extractContentFlags(args.signalText),
  };
}
