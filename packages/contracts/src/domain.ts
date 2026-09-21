// The email/domain grammar: split an address, normalize a domain, and decide
// whether a string is a syntactically valid one.
//
// This module holds the one implementation of the address/domain split its
// importers share. A module that needs an address's domain imports
// `emailDomain`; a module that needs both halves imports `splitEmail`. So the
// domain classifier (`identity-affiliation.ts`), the domain identity floor
// (`user-model.ts`, through the same `./hostname` fragment), and a stored
// standing-instruction target all read the same rule. A second, stricter
// grammar restates the same local-part decision as a regex in `user-model.ts`
// (`IDENTITY_VALUE_FORMATS.email`, which also applies `HOSTNAME`);
// reconciling the two is queued as a follow-up and is not claimed here.
//
// Things this module does NOT own include, so a hand-written `@` split is not
// automatically a bug: a local-part slice taken for DISPLAY (a greeting, an
// avatar initial), the bulk-sender heuristic local-part read in `attention.ts`
// (whose `senderAddress` accepts a string with no `@`, so moving it onto
// `splitEmail` would change `isLikelyBulkSender`'s answer), the authority read
// of a URL, and the parse of an RFC 5322 Message-ID (which is not an
// address). Each asks a different question from the one this grammar answers,
// or asks it over inputs this grammar rejects.
//
// The claim is "one implementation", not "every call site already uses it".
// Known domain reads that still hand-roll the split include:
// `assistant/src/connections/object-state/github-adapter.ts`, the sibling
// `sentry-adapter.ts`, and `assistant/src/knowledge/cold-start/signals.ts`.
// They are named here rather than promised a date.
//
// A dependency-free leaf on purpose, like `./hostname` itself: `user-model.ts`
// value-imports `classifyEmailDomain` from `identity-affiliation.ts`, so any
// module that both `standing-instructions.ts` and `identity-affiliation.ts`
// import must sit BELOW that pair or it closes a runtime value cycle. It
// measured as a real one — `domainSchema` read from a half-initialized module
// threw `Cannot access 'domainSchema' before initialization` at import time.
//
// `index.ts` re-exports `emailDomain`, `splitEmail`, `domainSchema`,
// `extractEmailAddress` and `normalizeEmailAddress`. The rest stays internal
// grammar, not a public contract surface.

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
export const domainSchema: z.ZodType<string, string> = z
  .string()
  .transform(normalizeDomain)
  .refine(isValidDomain, { message: "must be a valid domain" });

const emailAddressSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * LOOSE: pull the bare lowercase `local@domain` out of a `From:`-style header,
 * unwrapping a `"Display Name <addr>"` form when present and dropping anything
 * with no `@`. Returns `null` for empty/garbage input.
 *
 * Byte-identical semantics to the old `parseEmailAddress` (which now delegates
 * here), so every self-mail / recipient / display caller keeps its behavior
 * with zero churn. This is the runtime-parse tier: it answers "what address
 * was written here", never "is this a mailable address".
 */
export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();

  return raw.includes("@") ? raw : null;
}

/**
 * STRICT: `extractEmailAddress`, then strip a `mailto:` prefix, then the
 * `z.email()` shape check. The one rule the `sender_email` target arm, the
 * suppression write path, and the read path share: every spelling of a live
 * sender (display-name wrapper, case, surrounding whitespace, `mailto:`)
 * flows through this, so a stored target matches iff the live mailbox is the
 * bound one. Stored rows are already canonical, so readers compare with `===`.
 */
export function normalizeEmailAddress(value: string | null | undefined): string | null {
  const extracted = extractEmailAddress(value);

  if (!extracted) return null;

  const candidate = extracted.replace(/^mailto:/i, "").trim();
  const parsed = emailAddressSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}
