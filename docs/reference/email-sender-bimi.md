# Email sending domain & BIMI / sender logo

Alfred sends transactional email (briefings, approvals, OTP fallbacks) through
**Resend**. As of 2026-06-12 the sending domain is **`alfred.beauty`** (was
`croisillies.xyz`).

## Current state

| Thing         | Value                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------- |
| From address  | `Alfred <hey@alfred.beauty>` (`RESEND_FROM_EMAIL`, set on Railway `server` + local `.env`)        |
| Resend domain | `alfred.beauty`, region `eu-west-1`, **verified** (id `cc812426-983d-4f25-abca-576512b07e5c`)     |
| DNS provider  | Vercel (apex uses Vercel nameservers; manage with `vercel dns`)                                   |
| Apex hosting  | Railway (`server: railway-hikari`) — `apps/web/public/*` is served at `https://alfred.beauty/...` |

### DNS records on alfred.beauty (added via `vercel dns add`)

- `resend._domainkey` TXT — DKIM public key (Resend)
- `send` MX → `feedback-smtp.eu-west-1.amazonses.com` (priority 10) — SPF return-path
- `send` TXT → `v=spf1 include:amazonses.com ~all`
- `_dmarc` TXT → `v=DMARC1; p=quarantine; rua=mailto:dmarc@alfred.beauty; adkim=r; aspf=r`
- `default._bimi` TXT → `v=BIMI1; l=https://alfred.beauty/bimi/alfred-bimi.svg; a=`

## Received mail: forward to the owner

The apex MX of `alfred.beauty` (`10 inbound-smtp.eu-west-1.amazonaws.com`) sends all mail for
`*@alfred.beauty` to Resend Receiving. Resend keeps the mail, but it has no forward rule. Replies
to `hey@alfred.beauty` also arrive there. Alfred forwards each received mail to the owner's
account email (`user.email`).

| Thing        | Value                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------- |
| Route        | `POST /webhooks/resend` (`packages/http/src/resend-webhook.ts`)                              |
| Logic        | `receiveResendWebhook` in `packages/assistant/src/delivery/inbound-forward.ts`               |
| Resend event | `email.received`                                                                             |
| Env          | `RESEND_WEBHOOK_SECRET` (the `whsec_...` signing secret). Unset means the route answers 503. |
| API key      | `RESEND_API_KEY` must have "Full access". A "Sending access" key cannot read received mail.  |
| Ledger       | One `email_sends` row with kind `inbound_forward` and key `inbound_forward:{email id}`       |

The route does these steps:

1. It checks the Svix signature over the raw body. A missing header or a bad signature gets 400.
2. It ignores all events other than `email.received`.
3. It ignores mail from the Alfred sender (`RESEND_FROM_EMAIL`). This stops a forward loop.
4. It finds the owner: the one user with a verified email. If there is not exactly one, it reports an error and does not forward.
5. It does not forward when the owner's address is on a receiving domain, because the forward would come back.
6. It reads the body (`html_format: "cid"`) and all the attachments from Resend.
7. It sends through `notify`: from the Alfred sender, with the original subject. Reply-To is the original Reply-To, or else the original sender.
8. The body starts with the original From, To, Cc, Date, and Subject. Resend fetches each attachment from its `download_url`. An inline image keeps its content id.

A failed read or send gets 500, so Resend retries. A retry reuses the `email_sends` row and the
Resend idempotency key, so the owner gets one copy. The forward is plumbing. The mail does not go
to triage, the corpus, or the briefing.

### Set it up

1. Make sure that `RESEND_API_KEY` on Railway `server` has "Full access".
2. In the Resend dashboard, open Webhooks and add the endpoint `https://api.alfred.beauty/webhooks/resend`.
3. Select only the event `email.received`.
4. Copy the signing secret into `RESEND_WEBHOOK_SECRET` on Railway `server`, then redeploy.

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
- The email _body_ logo (the inline `<img>` in templates) is separate from the
  BIMI avatar — it's the PNG at `{CORS_ORIGIN}/images/logo/alfred-logo-email.png`
  and is unaffected by any of the above.
- `croisillies.xyz` remains verified in Resend but is no longer used by Alfred;
  safe to remove later if desired (`resend domains rm d5fadb20-...`).
