// The email/domain grammar: split an address, normalize a domain, and decide
// whether a string is a syntactically valid one. Encoded ONCE, here, so the
// domain classifier (`identity-affiliation.ts`), the domain identity floor
// (`user-model.ts`, through the same `./hostname` fragment), and a stored
// standing-instruction target all read the same rule.
//
// A dependency-free leaf on purpose, like `./hostname` itself: `user-model.ts`
// value-imports `classifyEmailDomain` from `identity-affiliation.ts`, so any
// module that both `standing-instructions.ts` and `identity-affiliation.ts`
// import must sit BELOW that pair or it closes a runtime value cycle. It
// measured as a real one — `domainSchema` read from a half-initialized module
// threw `Cannot access 'domainSchema' before initialization` at import time.
//
// `index.ts` re-exports `emailDomain` and `domainSchema` only. The rest stays
// internal grammar, not a public contract surface.

import { z } from "zod";
import { HOSTNAME } from "./hostname";

// `HOSTNAME` is an unanchored fragment; anchor it here for a standalone domain.
const HOSTNAME_RE = new RegExp(`^${HOSTNAME}$`);

/** Trim, lowercase, and drop a trailing dot — the canonical spelling of a domain. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

/** True iff `domain` is a syntactically valid DNS domain. Expects a normalized value. */
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

/** Split a raw address into `{ localPart, domain }`, lowercased; null if not an address. */
export function splitEmail(email: string): { localPart: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");

  if (at <= 0 || at === trimmed.length - 1) return null;

  if (at !== trimmed.lastIndexOf("@")) return null;
  const localPart = trimmed.slice(0, at);

  if (!isValidEmailLocalPart(localPart)) return null;

  return { localPart, domain: normalizeDomain(trimmed.slice(at + 1)) };
}

/**
 * The lowercase domain of an email address. Null when the address is not
 * well-formed. One module answers "what is this address's domain", so a caller
 * never splits on `@` itself and never writes a second regular expression.
 */
export function emailDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = splitEmail(value);

  return parsed ? parsed.domain : null;
}

/**
 * A bare DNS domain: normalized (trim -> lowercase -> drop a trailing dot) and
 * validated against the shared hostname grammar. Use it wherever a domain is
 * stored or compared, so a stored domain is already canonical.
 */
export const domainSchema: z.ZodType<string> = z
  .string()
  .transform(normalizeDomain)
  .refine(isValidDomain, { message: "must be a valid domain" });
