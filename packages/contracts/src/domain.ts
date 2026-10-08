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

/** Normalize and validate a domain. Use it wherever a domain is stored or compared. */
export const domainSchema: z.ZodType<string, string> = z
  .string()
  .transform(normalizeDomain)
  .refine(isValidDomain, { message: "must be a valid domain" });

const emailAddressSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * Loose: get the lowercase address out of a `From:` header, with or without
 * `Name <addr>`. Answers "what was written", not "is this mailable".
 */
export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();

  return raw.includes("@") ? raw : null;
}

/**
 * Strict: `extractEmailAddress`, strip `mailto:`, then `z.email()`.
 * Stored sender targets use this, so readers compare them with `===`.
 */
export function normalizeEmailAddress(value: string | null | undefined): string | null {
  const extracted = extractEmailAddress(value);

  if (!extracted) return null;

  const candidate = extracted.replace(/^mailto:/i, "").trim();
  const parsed = emailAddressSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}
