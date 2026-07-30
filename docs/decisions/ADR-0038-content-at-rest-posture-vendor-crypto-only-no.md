# ADR-0038 — Content-at-rest posture: vendor crypto only, no app-layer encryption

> **Amended 2026-07-30 (#453) — credentials are carved out of this deferral.**
> Content keeps the posture below. OAuth **credentials** do not: `account` and
> `integration_credentials` token columns now hold AES-256-GCM envelopes under a
> separate KEK (`OAUTH_CREDENTIAL_KEK`). See "Amendment" at the end of this file.

**Decision.** No app-layer encryption on user content (`documents.content`, `chunks.content`, `attachment_pages.extracted_text`, `memory_facts.value`, briefing bodies, `email_sends.body`). Three concrete layers stand in:

1. **Vendor at-rest encryption** — Railway managed Postgres + Redis + object storage all encrypt disks/volumes at the provider layer. Already on, free.
2. **Log redaction** — Pino redactor + Sentry `beforeSend` scrubber for known sensitive field paths so accidental `console.log`, error breadcrumbs, and event payloads never carry plaintext content.
3. **Don't persist raw payloads** — `documents.raw` (the Gmail MIME tree) drops. Re-extraction means re-fetching from Gmail; Gmail is the durable copy.

**Why.** At single-user scale on a single Railway project, an app-layer key has exactly two homes:

- **(a) Railway env next to the DB.** The key and the ciphertext share a blast radius. An attacker who can pull a backup or read `DATABASE_URL` can also pull `ALFRED_CONTENT_KEY`. The encryption is ceremonial — it adds schema complexity (`_iv` + `_kid` columns on every content field, an `enc/dec` boundary on every write/read path) for ~zero real-world delta.
- **(b) Outside Railway** (1Password CLI / Mac Keychain pulled on boot). Real protection — the key never sits next to the ciphertext. But it's an operational tax (boot dependency on a secret-fetch step, dev-env gymnastics, key-rotation runbook) for a threat surface that doesn't yet exist on this project: no contractors, no analytics pipeline, no regular backup-export workflow, no compliance regime.

Either path is wrong for v1. (a) is theater; (b) is premature. Skip the layer cleanly and spend the budget on log redaction, which defends the actual high-frequency leak vector — most personal-data exposure in real systems is accidental logging, not DB exfiltration.

**The unfixable gap that exists either way: embedding inversion.** A `chunks.embedding` vector + the embedding model + published inversion techniques can reconstruct surprisingly accurate text. Encrypting the vector is not an option (kills pgvector indexing). The only defense is "trust your embedding provider" — contractual, not cryptographic. This is true with or without column-level encryption, so it does not tip the decision.

**What the posture defends against:**

| Threat | Posture defends? |
| --- | --- |
| Stolen Railway disk image / lost backup file | Vendor crypto ✅ |
| Accidental `console.log` of email body in a worker | Pino redactor ✅ |
| Error stack trace with chunk text reaches Sentry | Sentry scrubber ✅ |
| Fat `documents.raw` JSON copied into a debug dump | Column doesn't exist ✅ |
| App-server RCE | No (true for any server-side scheme) |
| Vendor employee with raw DB access | No (would need (b) above) |
| Voyage / Anthropic / Perplexity reading content we send them | No (contractual) |
| Embedding inversion from leaked vector | No (architectural) |

**Alternatives.**

- App-layer AES-256-GCM with key in Railway env (rejected — same blast radius as the DB; ceremonial).
- Key outside Railway via 1Password CLI / external secret store (rejected for v1 — real protection but premature for the actual threat surface).
- Per-user keys / envelope encryption with per-record DEKs (rejected — single user, single owner; ratio of complexity to delta is absurd).
- Searchable symmetric encryption / encrypted vector spaces (rejected — academic, fragile, and the only real win would be defending embedding inversion, which it doesn't).

**Triggers to revisit this ADR.** Any of these flips the math toward path (b) above:

- A contractor or second user lands on the system.
- A real backup-export workflow exists (regular `.sql` dumps moved off Railway, sent to anyone, or archived to a separate vendor).
- An analytics pipeline or read-replica gets DB-read access scoped narrower than the app's full secret set.
- A compliance regime (SOC2, HIPAA, GDPR contracts) becomes a real requirement.

Adding the encryption layer later is a straightforward forward migration — new `*_iv` / `*_kid` columns, a backfill job that reads plaintext and writes ciphertext, flip the read/write paths. The schema doesn't bake in irreversibility.

**Implementation shape.**

- `packages/api/src/lib/logging.ts` — Pino instance with `redact.paths` covering known sensitive field paths (`*.content`, `*.extracted_text`, `*.body`, `documents.raw`, `memory_facts.value`, `attachment_pages.*`). Redaction renders as `[REDACTED]` so the structural shape of logs is preserved for debugging.
- Sentry config (`apps/server/src/instrument.ts`) — `beforeSend` and `beforeBreadcrumb` hooks strip the same paths from event payloads. Errors keep their stack frames; only field values disappear.
- Drizzle migration — `documents` drops the `raw` column. Existing rows lose `raw`; we never read it on the hot path.
- Gmail ingest (`packages/integrations/src/google/gmail.ts`) — stops persisting the MIME tree. Extraction stays in-memory during the ingest job; `documents.metadata` keeps the small derived fields (sender, headers we actually use).
- Same redaction list lives in one shared const (`SENSITIVE_LOG_PATHS` in `@alfred/contracts`) so Pino, Sentry, and any future logger pull from one source.

**Caveat that goes in the codebase, not just here.** A short comment on `chunks.embedding` in `packages/db/src/schema/documents.ts` should call out: "Plaintext by design — encrypting kills pgvector. Embedding-inversion attacks can leak content from the vector alone; see ADR-0038." Future readers shouldn't discover the gap by accident.

---

## Amendment, 2026-07-30 — OAuth credentials are carved out (#453)

**What changes.** `account.access_token`, `account.refresh_token`,
`account.id_token`, `integration_credentials.access_token`, and
`integration_credentials.refresh_token` are encrypted at the application layer.
Everything else in the table above is unchanged: content stays vendor-encrypted
only.

**Why the original reasoning does not cover credentials.** The rejection above
rests on one argument — a key in Railway env shares a blast radius with the
ciphertext, so app-layer encryption is "theater". That argument is sound for
content and wrong for credentials, because the two have different failure
shapes:

- **Content is a disclosure.** A leaked email body is read once. The damage is
  bounded by what the row says.
- **A credential is a transferable capability.** A leaked `refresh_token` is a
  live grant against Gmail, Drive, GitHub, Notion, Vercel, or Railway, usable
  from anywhere, for as long as the grant survives. Railway workspace tokens
  cannot even be scoped down: one is full workspace write.

So the blast-radius argument still applies to the *same* attacker (app-server
RCE reads the KEK and calls `open`), but credentials have a *different* attacker
the content argument never had to price: anyone holding a database artifact that
travelled without the secret environment. A backup file, a support export, a
read replica, a snapshot in someone's downloads folder. For content that
attacker gets a disclosure the vendor-crypto row already covers. For credentials
that attacker gets Alfred's Google account.

**Two of this ADR's own revisit triggers already fired.** "A real
backup-export workflow exists" and the broadened surface: ADR-0052 added GitHub
App installation tokens, and the shared bearer layer added Railway, Notion, and
Vercel. The `integration_credentials` docstring had already recorded that the
deferral was sized for a read-mostly blast radius that no longer holds.

**What this defends, stated honestly.**

| Threat | Defended? |
| --- | --- |
| Leaked row, replica, snapshot, or support export | Yes — the tokens are envelopes |
| Off-platform backup that does not carry the env | Yes |
| Vendor employee with raw DB access | Yes, for credentials specifically |
| App-server RCE | **No** — that attacker reads the KEK and calls `open` |
| Someone who holds both the dump and the environment | No |

A KEK beside the app is a real reduction in blast radius, not secrecy from the
app itself. Do not let user-facing copy imply otherwise.

**Shape.** Envelope encryption, not direct: a per-secret 256-bit DEK encrypts
the token, and the KEK only wraps DEKs, so a future rotation rewraps 32 bytes
per row instead of re-encrypting every payload. `@alfred/db/credential-vault`
owns the representation; the Better Auth adapter decorator and the three
`@alfred/integrations` persistence modules are the only callers. Columns stay
`text` — the envelope carries its own version, algorithm, key id, nonces, and
tags, so there is no `*_iv` / `*_kid` column and no schema migration.

There is no plaintext-compatibility branch. A conversion runs once with every
writer stopped, and `startRuntime` re-checks it before the process serves
traffic. Procedure and rotation:
[`docs/runbooks/oauth-credential-vault-rollout.md`](../runbooks/oauth-credential-vault-rollout.md).

**Still deferred for content.** Path (b) — a key outside Railway — remains
unbuilt for both content and credentials. The triggers above still govern it.
