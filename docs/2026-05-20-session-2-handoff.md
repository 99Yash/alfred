# Alfred prod stabilisation — session 2 handoff (2026-05-20, evening)

**Picks up from** [`docs/railway-deploy-handoff.md`](./railway-deploy-handoff.md) (morning session) and continues through Gmail push activation + a domain cutover + a chain of latency hotfixes. Context window was filling so this is a clean handoff for the next session.

## TL;DR — what's live, what's not

| Surface | URL / artefact | Status |
|---|---|---|
| **Web app** | https://alfred.beauty | ✅ Live |
| **API** | https://api.alfred.beauty | ✅ Live (`/health` 200) |
| **Old Railway URLs** | `*-production-*.up.railway.app` | Still resolve; OAuth client still authorises them. Safe to leave or remove. |
| **alfred.beauty TLS** | Let's Encrypt, verified | ✅ Live (Vercel-managed nameservers, ALIAS apex + CNAME `api.*`) |
| **Gmail push subscription** | `gmail-push-prod` on `projects/vermithor-485206/topics/gmail-push` | ✅ Pushing to `https://api.alfred.beauty/webhooks/gmail` with OIDC (SA `gmail-push-pusher@vermithor-485206.iam.gserviceaccount.com`) |
| **Watch on credential `intc_llhmuwpjx68u`** | expires `2026-05-27T14:09:22.690Z` | ✅ Installed |
| **Triage classifier** | switched mid-session | `getCheapModel()` → **`gemini-2.5-flash-lite`** (PR #21 in flight at write time — see "Currently building" below) |
| **Triage labels** | switched mid-session | Reuses user's existing **Dimension numbered labels** (`2: action needed`, `6: fyi`, etc.) — PR #21 |
| **End-to-end inbound mail → label write-back** | ⚠️ **Working but not always firing** — see "Open issue" below |

### Currently building (at write time)

- **PR #21** (`feat(triage): reuse Dimension's numbered labels + swap to Flash-Lite`) merged at `2026-05-20T15:18:53Z`, deploying via `railway up` — status was BUILDING when this doc was written. Once it lands, future triage runs will:
  - write Dimension labels (`2: action needed`, `4: awaiting reply`, `5: meeting`, `6: fyi`, `8: payment`, `9: newsletter`) instead of `Alfred/*`
  - use `gemini-2.5-flash-lite` (lower latency, lower cost)
- One-shot SQL cache clear already ran (`metadata - 'alfredLabels'` on the Google credential) so `ensureAlfredLabels` re-resolves to the new label ids on first call after deploy.

---

## What got accomplished this session (chronological)

### 1. RESEND_FROM_EMAIL fix → sign-in unblock
- Prior session left `RESEND_FROM_EMAIL=Alfred <yashgouravkar@gmail.com>` — Resend silently rejects gmail.com as a from-address.
- `railway variables --service server --set 'RESEND_FROM_EMAIL=Alfred <yash@croisillies.xyz>'`
- Resend started delivering. OTP flow worked again.

### 2. SameSite=None cross-site cookie fix — PR #17
- Sign-in OTP succeeded but the SPA bounced straight back to `/login`. Cause: `web-production-125ee.up.railway.app` ↔ `server-production-c138.up.railway.app` are cross-site (both under `up.railway.app`, on the Public Suffix List). `SameSite=Lax` cookies got stripped on cross-site fetches.
- Patched `packages/auth/src/index.ts` to emit `SameSite=None; Secure` in prod (Lax kept locally).
- Railway's GitHub auto-deploy never fired — pushed via `railway up --service server --ci` from a fresh worktree off `main` with `.railwayignore` copied across.
- Sign-in click-through verified end-to-end.

### 3. Google OAuth round-trip verified on prod
- Hit `/api/integrations/google/connect` directly (the `/onboarding` route is on the unmerged `ui` branch, so prod 404s on it).
- Vermithor's "Alfred" OAuth client + correct prod redirect URI + full m7 scope set. Consent screen warning is normal (Testing-status app).
- Callback wrote credential `intc_llhmuwpjx68u` to prod Postgres with status=active, scopes openid/email/profile/gmail.readonly/modify/send.

### 4. Stale Railway services deleted
- Used Railway's GraphQL `serviceDelete` mutation directly (token at `~/.railway/config.json` under `user.token`).
- Removed: `Postgres-adAl`, `Postgres-ptcS`, `Postgres-d2zG` (verified empty by querying the project's vendored `pg` from `node_modules`), and the legacy `Redis`.
- `Postgres-d2zG`'s delete 504'd twice before completing — let the third attempt run with `--max-time 180`, eventually returned `{serviceDelete: true}`.

### 5. `alfred.beauty` cutover
- Vercel DNS records (Vercel is the registrar): apex `ALIAS lhlh7vu0.up.railway.app`, `api CNAME prz606yn.up.railway.app`, plus `_railway-verify(.api)` TXT records.
- Vercel CLI: `vercel dns add alfred.beauty <name> <type> <value>`.
- Let's Encrypt certs minted in <5 min. Confirmed via `openssl s_client`.
- Added new redirect URI + JS origin to the Google OAuth client (kept the old `*.up.railway.app` URIs as fallback).
- Flipped server env: `CORS_ORIGIN=https://alfred.beauty`, `GOOGLE_OAUTH_REDIRECT_URI=https://api.alfred.beauty/api/integrations/google/callback`. Web env: `VITE_API_URL=https://api.alfred.beauty`.
- Web bounced back to login on the new domain (cookies were on the old origin) — re-OTP'd fresh.

### 6. Gmail Pub/Sub push activation
- Created SA `gmail-push-pusher@vermithor-485206.iam.gserviceaccount.com` via Google Cloud Console IAM.
- Created push subscription `gmail-push-prod` → `https://api.alfred.beauty/webhooks/gmail` with OIDC auth (SA above, audience = the endpoint URL).
- Set `GOOGLE_PUBSUB_AUDIENCE` + `GOOGLE_PUBSUB_SERVICE_ACCOUNT` env on server.
- Installed watch on credential via `POST /api/integrations/google/intc_llhmuwpjx68u/watch`. Got back `baselineHistoryId=4089819, expiresAt=2026-05-27T14:09:22.690Z`.

### 7. Latency hotfix chain — PRs #18, #19, #20
Activation surfaced three bugs in the ingestion enqueue path, each requiring a hotfix:

- **PR #18** — `gmail-webhook.ts:136` used `gmail.poll_history:${credId}` as a custom BullMQ jobId. BullMQ forbids `:`. Every webhook delivery generated `[api] Unhandled error: Custom Id cannot contain :`. Fix: `:` → `.`.
- **PR #19** — same bug in `queue.ts:178` (`gmail.poll_sweep` branch). The 5-min poll fallback failed on every tick — 13 failed jobs in `ingestion-runs:failed`. Same fix.
- **PR #20** — even with the colon fix, the system worked for ~12 min and went silent again. Cause: `defaultJobOptions.removeOnComplete: { count: 50, age: 24h }` keeps completed jobs around, so re-enqueues with the same static custom `jobId` become silent no-ops for hours. Replaced both call sites with BullMQ v5's `deduplication: { id, ttl: 30_000 }` — collapses bursts in a 30s window, releases for fresh enqueues after.

Each PR followed the same pattern: hotfix branch off `main`, push, merge, `cp .railwayignore + railway up --service server --ci` (auto-deploy from GitHub never fires reliably on this account).

### 8. Manual Redis unblocking (twice)
Between deploys, two stale completed-job entries blocked new enqueues. Direct Redis delete via the public TCP proxy unblocked them so the next sweep tick could proceed:
```js
await r.zrem('bull:ingestion-runs:completed', 'gmail.poll_history.intc_llhmuwpjx68u');
await r.del('bull:ingestion-runs:gmail.poll_history.intc_llhmuwpjx68u');
```
Plus a force-enqueue from inside the prod container:
```js
const q = new Queue('ingestion-runs', { connection });
await q.add('gmail.poll_history', { kind: 'gmail.poll_history', credentialId: 'intc_llhmuwpjx68u', reason: 'manual-unblock' });
```
These were one-shot recoveries — PR #20 makes them unnecessary going forward.

### 9. Triage label + model swap — PR #21 (IN FLIGHT)
- Reuse Dimension's existing labels in the user's Gmail instead of creating `Alfred/*`.
- Bump `getCheapModel()` from `gemini-2.5-flash` → `gemini-2.5-flash-lite` for triage + memory extraction.
- One-shot cache invalidation already ran: `UPDATE integration_credentials SET metadata = metadata - 'alfredLabels' WHERE provider='google'`.
- **Status when this doc was written:** PR #21 merged at `2026-05-20T15:18:53Z`; `railway up` running, deploy in BUILDING state.

---

## Open issue — triage isn't firing for some inbound emails

User reports their 8:39 PM and 8:50 PM IST emails (= 15:09 and 15:20 UTC) didn't get tagged within a minute. Investigation:

- `last_sync_at` advanced for both timestamps → webhook delivered, OIDC passed, `pollGmailHistory` ran.
- Worker log line: `[ingestion:worker] gmail.poll_history credential=intc_llhmuwpjx68u reason=poll-fallback pages=1 inserted=0 errors=0 fullResync=false`
- `inserted=0` means the history range had changes but **none resulted in a new document insert**. No new document → `enqueueTriageRuns` is skipped (see `queue.ts:124`):
  ```ts
  if (!result.fullResync && result.insertedDocumentIds.length) {
    await enqueueTriageRuns(...)
  }
  ```

### Hypotheses worth pursuing next

1. **Gmail history events ≠ new messages**: `history.list` returns label modifications, archives, draft saves, etc. If a user-sent test email never lands in INBOX (or lands and gets immediately archived/labeled), no doc insert fires. Check what `pollGmailHistory` filters on in `packages/integrations/src/google/ingestor.ts`.
2. **Dedup by `gmail_message_id`**: if the message already exists in the docs table (e.g. duplicate from a prior sync), the insert is a no-op. Check the unique index + the `ON CONFLICT DO NOTHING` path.
3. **`reason=poll-fallback` instead of `reason=webhook`**: the sweep ran, not the webhook. Webhooks may not be firing for self-sent test mail at all — Gmail might only publish notifications for messages actually delivered to INBOX from external senders. Test with a real external sender to confirm.
4. **Triage workflow latency itself** (separate from sync latency): once a doc IS inserted, what's the end-to-end p50 from insert → label write-back? Worth measuring with Flash-Lite live. Look at `email_triage.created_at` vs the doc's `received_at`.

### Diagnostics to run next session

```js
// In the running container — see what pollGmailHistory actually fetched for the latest call
const { pollGmailHistory } = require('@alfred/integrations/google');
const result = await pollGmailHistory({ credentialId: 'intc_llhmuwpjx68u' });
console.log(result); // pagesFetched, inserted, insertedDocumentIds, errors, fullResync
```

```sql
-- See whether the user's recent emails are even in the docs table
SELECT id, title, authored_at, metadata->>'gmail_message_id', metadata->>'labelIds'
FROM documents
WHERE source = 'gmail'
ORDER BY authored_at DESC
LIMIT 10;
```

```sh
# Tail the worker live while the user sends a fresh email
railway logs --service server | grep -E "gmail|triage|webhook"
```

---

## Domains, ids, paths (current state)

```
GCP project ............ vermithor-485206
GCP OAuth client ID .... 307554259025-8i1gtd5m01dtmkrim6i166guu8t2sai7.apps.googleusercontent.com
Pub/Sub topic .......... projects/vermithor-485206/topics/gmail-push
Pub/Sub subscription ... gmail-push-prod  (push, OIDC, audience=https://api.alfred.beauty/webhooks/gmail)
Pub/Sub OIDC SA ........ gmail-push-pusher@vermithor-485206.iam.gserviceaccount.com

Railway project ........ alfred (ID 0ec1ea83-240d-4306-bf7c-7de61d115b82)
Railway env ............ production (ID 9fbd12bc-6b88-430f-ac88-3ce71b60714b)
Server service ......... 822564df-4127-463b-b7ac-6174125951d9
Web service ............ 2155bb3b-873d-49c2-a690-e2d58f67dc90
Postgres service ....... 05cab70e-e253-4353-a5dc-39376c5ad4d6
Redis-E37o ............. 12810bc1-eedd-445a-afa2-f6689e0bb5be

Vercel domains ......... alfred.beauty + wrdn.beauty (wrdn.beauty reserved for the Warden project; not wired)

Web ................... https://alfred.beauty
API ................... https://api.alfred.beauty
Connected Google cred . intc_llhmuwpjx68u (yashgouravkar@gmail.com)
```

## Useful one-liners

```sh
# Railway GraphQL token (for serviceDelete etc — no CLI subcommand)
python3 -c "import json; print(json.load(open('/Users/yash/.railway/config.json'))['user']['token'])"

# Deploy from a clean main worktree (auto-deploy is unreliable on this account)
git fetch origin main && git worktree add ../alfred-deploy origin/main
cp /Users/yash/Developer/self/alfred/.railwayignore ../alfred-deploy/
cd ../alfred-deploy && railway link --project alfred --environment production --service server
railway up --service server --ci

# Tail prod server logs (rolling buffer is small)
railway logs --service server

# psql via SSH'd server container (DATABASE_URL only resolves internally)
B64=$(base64 -i /tmp/some-node-script.js | tr -d '\n')
railway ssh --service server -- "bash -c 'echo $B64 | base64 -d > /tmp/s.js && node /tmp/s.js'"

# Redis (BullMQ queue inspection) — public TCP proxy
node -e "const R=require('/Users/yash/Developer/self/alfred/node_modules/.pnpm/ioredis@5.10.1/node_modules/ioredis'); ..."
REDIS_PUBLIC_URL='<redacted — pull from Railway: railway variables --service Redis-E37o --kv | grep REDIS_PUBLIC_URL>'
```

## PRs landed this session

1. **[#17](https://github.com/99Yash/alfred/pull/17)** — `fix(auth): set SameSite=None on prod cookies for cross-site web↔server`
2. **[#18](https://github.com/99Yash/alfred/pull/18)** — `fix(gmail-webhook): use ` + "`.`" + ` in poll-history jobId (BullMQ forbids ` + "`:`" + `)`
3. **[#19](https://github.com/99Yash/alfred/pull/19)** — `fix(ingestion): use ` + "`.`" + ` in poll_sweep jobId (matches webhook hotfix)`
4. **[#20](https://github.com/99Yash/alfred/pull/20)** — `fix(ingestion): TTL-based dedup for gmail.poll_history`
5. **[#21](https://github.com/99Yash/alfred/pull/21)** — `feat(triage): reuse Dimension's numbered labels + swap to Flash-Lite` (in flight)

All merged to `main`. All deployed via `railway up` (GitHub-trigger auto-deploy was unreliable today).

## Journals written this session

- `~/journal/2026-05-20T132158Z.md` — early prod sign-in + SameSite fix + Google OAuth verify
- `~/journal/2026-05-20T142912Z.md` — railway cleanup + alfred.beauty wiring + Gmail push activation

The next session should add an entry for this handoff and for whatever latency fix lands.

## Recommended next steps (in order)

1. **Wait for PR #21 to finish deploying** (check with `railway status --json`). Once live, send a real external email (not self-sent) and watch the server logs.
2. **Investigate `inserted=0`**: if real external emails also come back `inserted=0`, the bug is in `pollGmailHistory` or its doc-insert path. If only self-sent test mail is affected, that's expected and we should test with externals.
3. **Measure end-to-end latency** once a real insert + triage round-trip is captured: `received_at` → `email_triage.classified_at` → `email_triage.updated_at`. Target p50 < 5s.
4. **Add a `db:sync-prices` run** to backfill `model_prices` for `gemini-2.5-flash-lite` so metering logs proper cost (currently soft-fails to $0).
5. **Optional cleanup**: delete the now-unused `Alfred/ActionNeeded`, `Alfred/AwaitingReply`, `Alfred/FYI`, `Alfred/Meeting`, `Alfred/Newsletter`, `Alfred/Payment` labels from Gmail settings (they have message references from before the switch, so removing the label leaves the messages untagged — fine, they're old).
6. **Optional cleanup**: update `pending-setup.md` content sits as an uncommitted change on the `ui` branch — fold it into the next push to `ui` or move to `main`.
7. **Update `decisions.md` (or add an ADR)** to record the TTL-dedup design — the static jobId approach is a real footgun that bit twice in one session.

## Files modified, not yet committed (working tree state)

On branch `ui` (carried over from the morning session, untouched today):
- `pending-setup.md` (rewritten to reflect post-m7c-activation state)
- `apps/web/src/index.css`, `apps/web/src/lib/app-shell.tsx`, `apps/web/src/routeTree.gen.ts`, `packages/api/src/index.ts`, `packages/api/src/modules/integrations/google-routes.ts`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/auth.ts` (pre-existing ui-branch WIP — not mine)
- Untracked: `.railwayignore`, `apps/web/src/routes/onboarding.tsx`, `docs/railway-deploy-handoff.md`, `docs/2026-05-20-session-2-handoff.md` (this doc), `packages/api/src/modules/onboarding/`, `packages/db/src/migrations/0014_whole_menace.sql`, `packages/db/src/migrations/meta/0014_snapshot.json`

The hotfix worktree at `/Users/yash/Developer/self/alfred-hotfix-4` is still around and linked to Railway; remove with `git worktree remove --force ../alfred-hotfix-4` when done.

---

Good luck — most of the fragility is now behind us; what's left is one focused investigation into why some inbound emails are landing with `inserted=0`.
