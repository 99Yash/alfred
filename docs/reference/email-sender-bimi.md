# Email sending domain & BIMI / sender logo

Alfred sends transactional email (briefings, approvals, OTP fallbacks) through
**Resend**. As of 2026-06-12 the sending domain is **`alfred.beauty`** (was
`croisillies.xyz`).

## Current state

| Thing | Value |
| --- | --- |
| From address | `Alfred <hey@alfred.beauty>` (`RESEND_FROM_EMAIL`, set on Railway `server` + local `.env`) |
| Resend domain | `alfred.beauty`, region `eu-west-1`, **verified** (id `cc812426-983d-4f25-abca-576512b07e5c`) |
| DNS provider | Vercel (apex uses Vercel nameservers; manage with `vercel dns`) |
| Apex hosting | Railway (`server: railway-hikari`) — `apps/web/public/*` is served at `https://alfred.beauty/...` |

### DNS records on alfred.beauty (added via `vercel dns add`)

- `resend._domainkey` TXT — DKIM public key (Resend)
- `send` MX → `feedback-smtp.eu-west-1.amazonses.com` (priority 10) — SPF return-path
- `send` TXT → `v=spf1 include:amazonses.com ~all`
- `_dmarc` TXT → `v=DMARC1; p=quarantine; rua=mailto:dmarc@alfred.beauty; adkim=r; aspf=r`
- `default._bimi` TXT → `v=BIMI1; l=https://alfred.beauty/bimi/alfred-bimi.svg; a=`

## Sender logo (BIMI) — what's done, what's left

The "DP" next to the sender in Gmail is driven by **BIMI**. Two prerequisites
are met:

1. **DMARC at enforcement** — `p=quarantine`, `pct=100` (default). ✅
2. **BIMI-compliant logo** — `apps/web/public/bimi/alfred-bimi.svg`, authored as
   **SVG Tiny PS 1.2** (full-bleed square, single `<title>`, no filters /
   clipPath / scripts / external refs). ✅ in repo.

### Remaining steps (in order)

1. **Deploy the web service** so the SVG is live:
   `https://alfred.beauty/bimi/alfred-bimi.svg` must return `200` with
   `content-type: image/svg+xml`. (It ships with the next `apps/web` deploy.)
   Validate with the BIMI inspector at <https://bimigroup.org/bimi-generator/>.
   At this point the **self-asserted** logo (`a=` empty) renders on providers
   that don't require a certificate (e.g. some Yahoo/AOL paths). **Gmail and
   Apple Mail will still show the letter avatar** until step 3.

2. **Obtain a certificate** — Gmail/Apple only render the logo with a cert in
   `a=`. Two options, both from an authorized CA (**DigiCert** or **Entrust**):
   - **VMC (Verified Mark Certificate)** — requires the Alfred logo to be a
     **registered trademark** (USPTO/EUIPO/UKIPO/etc.). Registration is the long
     pole (months). ~$1000–1500/yr.
   - **CMC (Common Mark Certificate)** — accepted by Gmail and Apple since
     ~2024 for **non-trademarked** logos with prior use. Faster/cheaper, no
     trademark needed. **Recommended first step** unless a trademark already
     exists.
   The logo submitted for the cert must be the **same SVG** referenced by `l=`.

3. **Publish the cert** — host the issued `.pem` (cert chain) at
   `https://alfred.beauty/bimi/alfred-vmc.pem` (drop it in
   `apps/web/public/bimi/`), then update the BIMI record's `a=`:
   ```
   vercel dns rm <default._bimi record id>
   vercel dns add alfred.beauty default._bimi TXT \
     'v=BIMI1; l=https://alfred.beauty/bimi/alfred-bimi.svg; a=https://alfred.beauty/bimi/alfred-vmc.pem'
   ```
   Allow up to ~24–48h for Gmail to pick it up.

## Notes / gotchas

- Test sends: **only** to an allowlisted personal Gmail (`yashgouravkar@gmail.com`).
  Never `dev.7@oliv.ai` — it forwards to many dev accounts.
- The email *body* logo (the inline `<img>` in templates) is separate from the
  BIMI avatar — it's the PNG at `{CORS_ORIGIN}/images/logo/alfred-logo-email.png`
  and is unaffected by any of the above.
- `croisillies.xyz` remains verified in Resend but is no longer used by Alfred;
  safe to remove later if desired (`resend domains rm d5fadb20-...`).
