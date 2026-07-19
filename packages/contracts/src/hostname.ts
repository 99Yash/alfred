// The shared "what string is a syntactically valid DNS hostname" grammar
// (per-label shape, non-numeric TLD, ≤253 chars), encoded ONCE. Both the domain
// identity floor (`user-model.ts` → `identityValueMatchesKind("domain")`) and the
// domain classifier (`identity-affiliation.ts` → `classifyEmailDomain`) validate
// the same `orgDomain` write, so their notion of a valid hostname must not drift.
//
// This is a dependency-free leaf on purpose: `user-model.ts` value-imports
// `classifyEmailDomain` from `identity-affiliation.ts`, so having either of them
// import the grammar from the other would close a runtime value cycle. A leaf that
// imports nothing breaks that cleanly, and it stays private (NOT re-exported from
// `index.ts`) — these are internal grammar consts, not a public contract surface.
//
// Exports are UNANCHORED fragments; each caller supplies its own anchoring
// (`^...@${HOSTNAME}$`, `^${HOSTNAME}$`, `new RegExp(\`^${HOSTNAME}$\`)`).

// A DNS label: 1–63 chars, no leading/trailing hyphen. Written without lookbehind
// so it parses on every JS engine.
export const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

// Final DNS label: same label grammar, but must contain at least one letter. This
// rejects all-numeric pseudo-TLDs (`example.123`) while still accepting punycoded
// IDN labels (`xn--...`).
export const DNS_TLD = `(?=[a-z0-9-]*[a-z])${DNS_LABEL}`;

// A DNS hostname: ≥2 labels (must carry a TLD), each per `DNS_LABEL` (so no empty
// label, no leading/trailing hyphen — rejects `bad..com`, `-bad`, `bad-`), ≤253
// chars total, and a non-numeric TLD. The lookahead bounds only the host (`[^@]`,
// since a hostname never contains `@`), so the same fragment validates a standalone
// `domain` AND the part after `@` in an `email`.
export const HOSTNAME = `(?=[^@]{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*\\.${DNS_TLD}`;
