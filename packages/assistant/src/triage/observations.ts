import type { AccountPersona } from "@alfred/contracts";
// Top-level `import type`: an inline `{ type X }` survives as a side-effect import
// and loads the whole knowledge barrel at runtime.
import type { UserContextLine } from "../knowledge";
import type { TriageSenderKindSignal } from "./sender-kind";
import type { SenderPrior } from "./sender-priors";
import type { ThreadState } from "./thread-state";

/**
 * Pre-model context for the cheap classifier (ADR-0051 #4a). No IO. Its job is
 * to surface anomalies the model would miss, like a security word from a newsletter sender.
 */

// ---------------------------------------------------------------------------
// Gmail-native signals
// ---------------------------------------------------------------------------

export interface GmailSignals {
  /** Gmail inbox categories (`primary`, `promotions`, …). */
  categories: string[];
  important: boolean;
  starred: boolean;
  inInbox: boolean;
  /**
   * Gmail's spam verdict (#1098). The spam floor always demotes the reply lanes.
   * For `urgent`/`action_needed` it is only a prior (rule 20), so spam can stay urgent.
   */
  spam: boolean;
  /** User-deleted. A hint only; no floor reads it. */
  trash: boolean;
}

const GMAIL_CATEGORY_PREFIX = "CATEGORY_";

/** Map raw Gmail `labelIds` to the bounded signal set the model can use. */
export function extractGmailSignals(labelIds: readonly string[]): GmailSignals {
  const categories: string[] = [];
  let important = false;
  let starred = false;
  let inInbox = false;
  let spam = false;
  let trash = false;

  for (const id of labelIds) {
    if (id.startsWith(GMAIL_CATEGORY_PREFIX)) {
      categories.push(id.slice(GMAIL_CATEGORY_PREFIX.length).toLowerCase());
    } else if (id === "IMPORTANT") important = true;
    else if (id === "STARRED") starred = true;
    else if (id === "INBOX") inInbox = true;
    else if (id === "SPAM") spam = true;
    else if (id === "TRASH") trash = true;
  }

  categories.sort();

  return { categories, important, starred, inInbox, spam, trash };
}

// ---------------------------------------------------------------------------
// Content flags (cheap regex)
// ---------------------------------------------------------------------------

export interface ContentFlags {
  hasUnsubscribe: boolean;
  hasCurrencyAmount: boolean;
  /**
   * Broad security vocabulary; every vendor auth echo sets it. A hint only:
   * no deterministic path may turn it into `urgent` or `action_needed`.
   */
  hasSecurityKeyword: boolean;
  hasCalendarInvite: boolean;
  /** Investor/AGM notice language, for rule 9. A hint, never a category rewrite. */
  hasInvestorNotice: boolean;
  /** Public-event blast language, for rule 8. A hint, never a category rewrite. */
  hasPublicEventLanguage: boolean;
}

const UNSUBSCRIBE_RE = /\bunsubscribe\b|\bmanage (your )?preferences\b|list-unsubscribe/i;

// No `\b` after a glyph: it never holds after `€`, so `1.000,00 €` would not match.
// `{0,20}`, not `*`: the body is uncapped and `*` backtracks quadratically (ReDoS).
const CURRENCY_RE =
  /(?:[$€£₹]\s?\d|\b(?:usd|eur|gbp|inr)\b\s?\d|\d[\d.,]{0,20}\s?(?:[$€£₹]|\b(?:usd|eur|gbp|inr)\b))/i;

const SECURITY_RE =
  /\bcve-\d{4}-\d+\b|\b(?:exposed|leaked|compromised)\b|\b(?:secret|credential|api[ -]?key|token|private key|password|passkey|security key|authenticator app|two[- ]factor|two[- ]step|2fa|mfa|2[- ]step|recovery (?:email|phone)|login method|oauth application)\b|\b(?:unauthorized|suspicious) (?:sign-?in|login|access)\b/i;

const CALENDAR_RE = /BEGIN:VCALENDAR|BEGIN:VEVENT|\bical\b|text\/calendar/i;

// `proxy`/`registrar` are qualified: bare words match "reverse proxy" in dev mail.
const INVESTOR_RE =
  /\bannual general meeting\b|\bagm\b|\bshareholder(?:s)?\b|\bproxy\s+(?:vote|voting|statement|card|form|materials?)\b|\be-?voting\b|\bevoting\b|\bannual report\b|\bregistrar\s+(?:and|&|to)\b|\bdepository\b|\bnsdl\b|\bcdsl\b/i;

// `conference` skips "conference call/room"; the trailing `\b` keeps "conference calligraphy".
const PUBLIC_EVENT_RE =
  /\bwwdc\d*\b|\bkeynote\b|\bwebinar\b|\bconferences?\b(?!\s+(?:call|rooms?|line|bridge|dial-?in)\b)|\bsummit\b|\bproduct launch\b|\blaunch event\b|\bpublic event\b|\bsave the date\b/i;

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
    /** Empty when the sender has no prior. */
    categoryCounts: Record<string, number>;
    lastCategory: string | null;
  };
  /** Null until detected on the credential. */
  persona: AccountPersona | null;
  thread: ThreadState;
  knownContact: boolean;
  /** Rendered relationship line for a human sender (ADR-0059); null for non-humans. */
  senderRelationship: string | null;
  /** Typed twin of `senderRelationship` for the cold-sender todo gate (rule 16b). */
  senderRelationshipIsCold: boolean;
  /** The projection says this sender is a non-person. Null means no opinion, not "person". */
  senderKind: TriageSenderKindSignal | null;
  /** The only observation in the user's own words, so it outranks the rest. */
  standingInstruction: TriageStandingDirective | null;
  /** Trace only: a null `standingInstruction` means unknown, not none. */
  standingInstructionReadFailed: boolean;
  /** Cold-start research prior (ADR-0050 D1). Weaker than the body and the user's words. */
  userContext: UserContextLine | null;
  /** A null `userContext` means unknown, not absent. Else a total read failure looks normal. */
  userContextReadFailed: boolean;
  gmail: GmailSignals;
  content: ContentFlags;
}

/**
 * `phrasing` is the user's words and is rendered. `directive` is model-composed and
 * is not. `factId` lets the trace join back to the instruction.
 */
export interface TriageStandingDirective {
  factId: string;
  directive: string;
  phrasing: string;
}

export interface AssembleObservationsArgs {
  /** From `senderKeyFor`; null for humans. */
  senderKey: string | null;
  senderPrior: SenderPrior | null;
  persona: AccountPersona | null;
  thread: ThreadState;
  knownContact: boolean;
  senderRelationship: string | null;
  // The optional fields below default so evals and smokes can skip them;
  // `gatherObservations` always passes them.
  senderRelationshipIsCold?: boolean;
  senderKind: TriageSenderKindSignal | null;
  standingInstruction?: TriageStandingDirective | null | undefined;
  standingInstructionReadFailed?: boolean | undefined;
  /** Not capped here; `classify.ts` caps it at render. */
  userContext?: UserContextLine | null | undefined;
  userContextReadFailed?: boolean | undefined;
  labelIds: readonly string[];
  /** Subject + body + headers, any case. */
  signalText: string;
}

/** Pure and order-stable, so traces diff cleanly. */
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
    senderRelationship: args.senderRelationship,
    senderRelationshipIsCold: args.senderRelationshipIsCold ?? false,
    senderKind: args.senderKind,
    standingInstruction: args.standingInstruction ?? null,
    standingInstructionReadFailed: args.standingInstructionReadFailed ?? false,
    userContext: args.userContext ?? null,
    userContextReadFailed: args.userContextReadFailed ?? false,
    gmail: extractGmailSignals(args.labelIds),
    content: extractContentFlags(args.signalText),
  };
}
