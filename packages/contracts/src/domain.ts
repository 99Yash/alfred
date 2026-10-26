// Email and domain grammar: split an address, normalize a domain, validate one.
//
// Keep this a dependency-free leaf. `user-model.ts` value-imports from
// `identity-affiliation.ts`, so a module both of them import must sit below that
// pair. Otherwise import throws `Cannot access 'domainSchema' before initialization`.

import { z } from "zod";
import { HOSTNAME } from "./hostname";

// `HOSTNAME` is an unanchored fragment; anchor it here for a standalone domain.
const HOSTNAME_RE = new RegExp(`^${HOSTNAME}$`);

/** Trim, lowercase, and drop a trailing dot. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

/** Expects a normalized value. */
export function isValidDomain(domain: string): boolean {
  return HOSTNAME_RE.test(domain);
}

function isValidEmailLocalPart(localPart: string): boolean {
  for (const ch of localPart) {
    const code = ch.charCodeAt(0);

    if (code <= 0x1f || code === 0x7f || ch === "@" || /\s/u.test(ch)) return false;
  }

  return true;
}

/** Lowercased; null if not an address. */
export function splitEmail(email: string): { localPart: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");

  if (at <= 0 || at === trimmed.length - 1) return null;

  if (at !== trimmed.lastIndexOf("@")) return null;
  const localPart = trimmed.slice(0, at);

  if (!isValidEmailLocalPart(localPart)) return null;

  return { localPart, domain: normalizeDomain(trimmed.slice(at + 1)) };
}

/** Lowercase domain of an address, or null when malformed. */
export function emailDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = splitEmail(value);

  return parsed ? parsed.domain : null;
}

/**
 * True when `domain` is `base` or a subdomain of it (`notify.railway.app` for
 * `railway.app`). The match is on whole labels, so `evilrailway.app` is not one.
 * Both values must already be normalized: the comparison is case-sensitive, like
 * the `emailDomain` and `normalizeDomain` output its callers pass.
 */
export function isDomainOrSubdomain(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

/** Normalize and validate a domain. Use it wherever a domain is stored or compared. */
export const domainSchema: z.ZodType<string, string> = z
  .string()
  .transform(normalizeDomain)
  .refine(isValidDomain, { message: "must be a valid domain" });

const emailAddressSchema = z.string().trim().toLowerCase().pipe(z.email());

/** One mailbox from a `From:`-style header: `Name <addr>`, `<addr>`, or `addr`. */
export interface Mailbox {
  /** Outer quotes stripped, backslash escapes removed, trimmed. Null when empty. */
  readonly displayName: string | null;
  /** Trimmed and lowercased: the same string `canonicalizeIdentityValue("email", …)` gives. */
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
}

const ANCHORED_ANGLE_RE = /^(.*?)<([^>]+)>\s*$/;

const ANY_ANGLE_RE = /^(.*?)<([^>]+)>/;

function cleanDisplayName(raw: string): string | null {
  let name = raw.trim().replace(/^"+/, "");

  // Drop closing quotes, but keep an escaped one (`"Ada \"AL\""`).
  while (name.endsWith('"') && !name.endsWith('\\"')) name = name.slice(0, -1);

  return name.replace(/\\(.)/g, "$1").trim() || null;
}

/**
 * Loose: answers "what was written", not "is this mailable". Text after `>`
 * (`Ada <a@x.com> (via list)`) is dropped. The address splits at the last `@`;
 * both halves must be non-empty. Null when there is no `local@domain`.
 */
export function parseMailbox(raw: string | null | undefined): Mailbox | null {
  const trimmed = raw?.trim();

  if (!trimmed) return null;
  const angle = ANCHORED_ANGLE_RE.exec(trimmed) ?? ANY_ANGLE_RE.exec(trimmed);
  const address = (angle?.[2] ?? trimmed).trim().toLowerCase();
  const at = address.lastIndexOf("@");

  if (at < 1 || at === address.length - 1) return null;

  return {
    displayName: angle ? cleanDisplayName(angle[1] ?? "") : null,
    address,
    localPart: address.slice(0, at),
    domain: address.slice(at + 1),
  };
}

/** The display label: name, else address, else the trimmed raw text, else null. */
export function mailboxLabel(raw: string | null | undefined): string | null {
  const mailbox = parseMailbox(raw);

  return mailbox?.displayName ?? mailbox?.address ?? (raw?.trim() || null);
}

/**
 * Split a To/Cc list on top-level commas. Honors quotes, backslash escapes, and
 * angle brackets, so `"Doe, Jane" <j@x.com>` stays one token.
 */
export function splitAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (!inQuote && char === "<") angleDepth++;

    if (!inQuote && char === ">" && angleDepth > 0) angleDepth--;

    if (!inQuote && angleDepth === 0 && char === ",") {
      const trimmed = current.trim();

      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();

  if (trimmed) parts.push(trimmed);

  return parts;
}

/**
 * Strict: `parseMailbox`, strip `mailto:`, then `z.email()`.
 * Stored sender targets use this, so readers compare them with `===`.
 */
export function normalizeEmailAddress(value: string | null | undefined): string | null {
  const mailbox = parseMailbox(value);

  if (!mailbox) return null;

  const candidate = mailbox.address.replace(/^mailto:/i, "").trim();
  const parsed = emailAddressSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}
