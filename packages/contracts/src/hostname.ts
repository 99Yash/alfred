// The one DNS hostname grammar, shared by `user-model.ts` and `domain.ts`.
// A leaf with no imports, so sharing it cannot create an import cycle. Not exported from `index.ts`.
// Fragments are unanchored; each caller adds `^` and `$`.

// 1 to 63 chars, no hyphen at either end. No lookbehind, for older engines.
export const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

// The TLD needs a letter: rejects `example.123`, accepts punycode `xn--...`.
export const DNS_TLD = `(?=[a-z0-9-]*[a-z])${DNS_LABEL}`;

// Two or more labels, 253 chars max. The length lookahead skips `@`, so the same
// fragment works alone and after the `@` of an email.
export const HOSTNAME = `(?=[^@]{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*\\.${DNS_TLD}`;
