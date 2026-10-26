/**
 * The one sender-word vocabulary. A local part, a domain, and a display name each
 * get one class here. Each reader maps the class to its own output through a total
 * `satisfies Record<…>` table, so a new class fails to compile until every reader
 * decides what it means. No reader keeps a word list or a sender regex of its own.
 * Pure module: the web client imports it.
 */

import { isDomainOrSubdomain } from "./domain";
import { collapseWhitespace } from "./text";

export const SENDER_CLASSES = ["automated", "role", "group", "none"] as const;

export type SenderClass = (typeof SENDER_CLASSES)[number];

/** How the word was found. Readers trust a whole or edge match more than a token match. */
export const LOCAL_PART_MATCHES = ["whole", "edge", "token"] as const;

export type LocalPartMatch = (typeof LOCAL_PART_MATCHES)[number];

export type MatchedSenderClass = Exclude<SenderClass, "none">;

/**
 * Word → class. A machine word is stored without separators (`noreply`) and
 * matches with any `.`/`_`/`-`/`+` inside it (`no-reply`, `do.not.reply`).
 * Role and group words match as one token only.
 */
const SENDER_WORDS = {
  // Nobody reads the reply.
  noreply: "automated",
  donotreply: "automated",
  notification: "automated",
  notifications: "automated",
  alert: "automated",
  alerts: "automated",
  mailerdaemon: "automated",
  postmaster: "automated",
  bounce: "automated",
  bounces: "automated",
  mailer: "automated",
  notify: "automated",
  automated: "automated",
  autoconfirm: "automated",
  // A shared mailbox. Small companies staff these, so a role word alone never demotes.
  info: "role",
  hello: "role",
  contact: "role",
  support: "role",
  help: "role",
  helpdesk: "role",
  billing: "role",
  invoices: "role",
  security: "role",
  abuse: "role",
  account: "role",
  accounts: "role",
  updates: "role",
  news: "role",
  newsletter: "role",
  events: "role",
  event: "role",
  marketing: "role",
  admin: "role",
  administrator: "role",
  root: "role",
  webmaster: "role",
  service: "role",
  services: "role",
  reply: "role",
  // A distribution list or a team.
  all: "group",
  everyone: "group",
  team: "group",
  engineering: "group",
  eng: "group",
  dev: "group",
  developer: "group",
  developers: "group",
  product: "group",
  design: "group",
  sales: "group",
  ops: "group",
  people: "group",
  hr: "group",
  finance: "group",
} as const satisfies Record<string, MatchedSenderClass>;

export type SenderWord = keyof typeof SENDER_WORDS;

export type LocalPartClass =
  | {
      readonly senderClass: MatchedSenderClass;
      readonly match: LocalPartMatch;
      /** The table word for a whole or token match; `null` for an edge match. */
      readonly word: SenderWord | null;
    }
  | { readonly senderClass: "none"; readonly match: null; readonly word: null };

const NO_CLASS: LocalPartClass = { senderClass: "none", match: null, word: null };

const TOKEN_SEPARATOR_RE = /[._+-]/;

/** Edge prefixes of a machine mailbox (`noreply-x`, `bounces.x`). */
const AUTOMATED_PREFIX_RE =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|bounces?[-_.])/;

/**
 * Edge prefixes of a department mailbox (`billing-eu`, `calendar-notification`).
 * They are `role`, not `automated`, so the bulk gate does not read them. A dotted
 * prefix (`billing.ops`) is the `first.last` person shape, so these take `-`/`_` only.
 */
const ROLE_PREFIX_RE = /^(?:billing|security|account|calendar)[-_]/;

/**
 * A service word as the last separated token (`messages-noreply`, `nse_alerts`,
 * `x.update`). Without this, a joined local part parsed as a first.last person
 * name (#1097, #1100). A separator is required, so a staffed bare `news@` stays a role.
 */
const SERVICE_WORD_SUFFIX_RE =
  /[-_.](?:no[-_]?reply|donotreply|do[-_]not[-_]reply|alerts?|notifications?|newsletters?|news|updates?)$/;

/** Lower wins among token matches. */
const TOKEN_CLASS_RANK = {
  automated: 0,
  role: 1,
  group: 2,
} satisfies Record<MatchedSenderClass, number>;

/** Machine words are at most three tokens long (`do-not-reply`). */
const MAX_GLUED_TOKENS = 3;

function isSenderWord(value: string): value is SenderWord {
  return Object.hasOwn(SENDER_WORDS, value);
}

function senderWord(value: string): SenderWord | null {
  return isSenderWord(value) ? value : null;
}

function senderWordClass(word: SenderWord): MatchedSenderClass {
  return SENDER_WORDS[word];
}

/** The table word for a run of tokens. A run of two or more matches a machine word only. */
function wordForRun(tokens: readonly string[]): SenderWord | null {
  const word = senderWord(tokens.join(""));

  if (!word) return null;

  return tokens.length === 1 || senderWordClass(word) === "automated" ? word : null;
}

/**
 * Classify a mailbox local part (lowercased here). The order is whole, then edge,
 * then token. Among tokens, `automated` beats `role`, and `role` beats `group`.
 */
export function classifyLocalPart(localPart: string): LocalPartClass {
  const value = localPart.trim().toLowerCase();

  if (!value) return NO_CLASS;
  const tokens = value.split(TOKEN_SEPARATOR_RE).filter(Boolean);
  const whole = tokens.length > 0 ? wordForRun(tokens) : null;

  if (whole) return { senderClass: senderWordClass(whole), match: "whole", word: whole };

  if (AUTOMATED_PREFIX_RE.test(value) || SERVICE_WORD_SUFFIX_RE.test(value)) {
    return { senderClass: "automated", match: "edge", word: null };
  }

  if (ROLE_PREFIX_RE.test(value)) return { senderClass: "role", match: "edge", word: null };

  let best: { readonly senderClass: MatchedSenderClass; readonly word: SenderWord } | null = null;

  for (let start = 0; start < tokens.length; start++) {
    for (let end = start + 1; end <= Math.min(tokens.length, start + MAX_GLUED_TOKENS); end++) {
      const word = wordForRun(tokens.slice(start, end));

      if (!word) continue;
      const senderClass = senderWordClass(word);

      if (!best || TOKEN_CLASS_RANK[senderClass] < TOKEN_CLASS_RANK[best.senderClass]) {
        best = { senderClass, word };
      }
    }
  }

  return best ? { ...best, match: "token" } : NO_CLASS;
}

/**
 * A group word anywhere: the whole local part or one token
 * (`engineering-team@`, `hr.priya@`). A weak signal only.
 */
export function isGroupLocal(localPart: string): boolean {
  return localPart
    .trim()
    .toLowerCase()
    .split(TOKEN_SEPARATOR_RE)
    .some((token) => {
      const word = senderWord(token);

      return word !== null && senderWordClass(word) === "group";
    });
}

/** The whole local part is a group word, no infix (#1187). `dev.patel@` is a person. */
export function isExactGroupLocal(localPart: string): boolean {
  const classified = classifyLocalPart(localPart);

  return classified.senderClass === "group" && classified.match === "whole";
}

const FIRST_LAST_LOCAL_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/i;

/** `first.last`, `first_last`, `first-last`: the shape of a person's mailbox. */
export function isFirstLastLocalPart(localPart: string): boolean {
  return FIRST_LAST_LOCAL_RE.test(localPart);
}

// ─── Domains ─────────────────────────────────────────────────────────────────

/**
 * Platforms that send mail for their users. The address belongs to the platform
 * even when a person's name is on it ("Vaibhav (via LinkedIn)").
 * Suffix match: `noreply.github.com` and `accounts.google.com` are covered.
 */
const SERVICE_PLATFORM_DOMAINS: readonly string[] = [
  "github.com",
  "linear.app",
  "clickup.com",
  "slack.com",
  "stripe.com",
  "stripe.email",
  "sentry.io",
  "vercel.com",
  "vercel.app",
  "vercel-app.com",
  "railway.app",
  "notion.so",
  "atlassian.net",
  "google.com",
  "amazonaws.com",
  "amazonses.com",
  "datadog.com",
  "datadoghq.com",
  "linkedin.com",
];

/** True when the domain is, or is under, a platform that sends mail for its users. */
export function isServicePlatformDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();

  return SERVICE_PLATFORM_DOMAINS.some((suffix) => isDomainOrSubdomain(normalized, suffix));
}

export const DOMAIN_FIRST_LABEL_CLASSES = ["automated", "infrastructure", "none"] as const;

export type DomainFirstLabelClass = (typeof DOMAIN_FIRST_LABEL_CLASSES)[number];

/**
 * Leftmost host labels. `automated` means the same as a machine local part
 * (`noreply.github.com`). `infrastructure` is a mail host (`mail.acme.com`):
 * it says nothing about the sender, because `jane@mail.company.com` is a person.
 */
const DOMAIN_FIRST_LABELS = {
  noreply: "automated",
  "no-reply": "automated",
  no_reply: "automated",
  donotreply: "automated",
  "do-not-reply": "automated",
  do_not_reply: "automated",
  newsletter: "automated",
  newsletters: "automated",
  bounce: "infrastructure",
  bounces: "infrastructure",
  mailer: "infrastructure",
  mail: "infrastructure",
  email: "infrastructure",
  smtp: "infrastructure",
  mta: "infrastructure",
  notification: "infrastructure",
  notifications: "infrastructure",
  notify: "infrastructure",
  send: "infrastructure",
  sendgrid: "infrastructure",
  mailgun: "infrastructure",
} as const satisfies Record<string, Exclude<DomainFirstLabelClass, "none">>;

type DomainFirstLabel = keyof typeof DOMAIN_FIRST_LABELS;

function isDomainFirstLabel(value: string): value is DomainFirstLabel {
  return Object.hasOwn(DOMAIN_FIRST_LABELS, value);
}

/** The class of the leftmost label. The caller decides if an apex domain (`noreply.com`) counts. */
export function classifyDomainFirstLabel(domain: string): DomainFirstLabelClass {
  const firstLabel = domain.trim().toLowerCase().split(".", 1)[0] ?? "";

  return isDomainFirstLabel(firstLabel) ? DOMAIN_FIRST_LABELS[firstLabel] : "none";
}

// ─── Display names ───────────────────────────────────────────────────────────

/** A name token: a word (`O'Neil`, `Mary-Jane`), an initial (`J.`), or one letter or CJK run. */
const PERSON_DISPLAY_RE = /^\p{L}[\p{L}'-]*\.?(?:\s+\p{L}[\p{L}'-]*\.?)+$/u;

/** Words that mark an organization, a team, or a machine, not a person. */
const NON_PERSON_DISPLAY_RE =
  /\b(inc|incorporated|ltd|limited|llc|llp|gmbh|plc|corp|corporation|company|co|team|engineering|notifications?|alerts?|depository|registrar|bank|services?|support|billing|payroll|careers?|jobs|sales|marketing|newsletters?|news|security|updates|digest|no[-\s]?reply|noreply|admin)\b/i;

/** A trailing `(…)` note (`Jane Doe (Acme)`, `Sam (she/her)`). */
const TRAILING_PARENTHETICAL_RE = /\s*\([^()]*\)\s*$/;

/** True when the display name has the shape of a person's name: two or more name tokens and no org word. */
export function isLikelyPersonDisplayName(displayName: string | null | undefined): boolean {
  if (!displayName) return false;

  const normalized = collapseWhitespace(
    collapseWhitespace(displayName.replace(/^"+|"+$/g, "")).replace(TRAILING_PARENTHETICAL_RE, ""),
  );

  if (!normalized || NON_PERSON_DISPLAY_RE.test(normalized)) return false;

  return PERSON_DISPLAY_RE.test(normalized);
}
