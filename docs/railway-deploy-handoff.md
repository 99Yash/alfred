# Railway production deploy — handoff

**Date:** 2026-05-20
**Session goal:** Migrate Alfred off Sedat's `labquote-ai` GCP project onto the user's own `vermithor-485206`, then deploy server + web to Railway prod and validate end-to-end auth.

This document captures everything done, what works, what's still broken, and the concrete actions to pick this back up cleanly.

---

## TL;DR — current state

| Component | URL / Resource | Status |
|---|---|---|
| **Web (prod)** | https://web-production-125ee.up.railway.app | ✅ Online, served from `web` service |
| **Server (prod)** | https://server-production-c138.up.railway.app | ✅ Online, `/health` returns `{"ok":true,"db":"connected"}` |
| **Postgres (prod)** | service `Postgres` in alfred project | ✅ Online, **migrations applied** (14 migrations through `0014_whole_menace.sql`), pgvector working |
| **Redis (prod)** | service `Redis-E37o` in alfred project | ✅ Online |
| **GCP project** | `vermithor-485206` (display name renamed to "Alfred") | ✅ Owner: yashgouravkar@gmail.com |
| **OAuth client "Alfred"** | client_id `307554259025-8i1gtd5m01dtmkrim6i166guu8t2sai7` | ✅ Both localhost + prod URIs wired |
| **Gmail-push topic** | `projects/vermithor-485206/topics/gmail-push` | ✅ Publisher binding granted to `gmail-api-push@system.gserviceaccount.com` |
| **End-to-end sign-in on prod** | OTP → Verify → onboarding | ⚠️ **Blocked by misconfigured `RESEND_FROM_EMAIL`** — see "Critical follow-ups" |

**Deployment is functionally done.** The only thing blocking a clean smoke-test click-through is one bad env var.

---

## What got accomplished this session

### Phase 1 — GCP migration off labquote-ai (m7c)

Sedat's `labquote-ai` project only granted yashgouravkar@gmail.com `roles/editor`, which couldn't even READ the Pub/Sub topic's IAM policy ("you do not have permission to view the permissions"). Migrated to `vermithor-485206` (one of the user's dormant projects, picked from a list of 13):

1. Enabled Gmail API and Cloud Pub/Sub API
2. Renamed Branding app name from "Vermithor" to "Alfred"
3. Audience: Testing publishing status (no verification needed for restricted scopes), added `yashgouravkar@gmail.com` as test user
4. Created new "Alfred" OAuth Web client. Captured client_id + secret. Added both localhost AND prod URIs:
   - JS origins: `http://localhost:3000`, `https://web-production-125ee.up.railway.app`
   - Redirect URIs: `http://localhost:3001/api/integrations/google/callback`, `https://server-production-c138.up.railway.app/api/integrations/google/callback`
5. Created `gmail-push` Pub/Sub topic in vermithor
6. Granted `roles/pubsub.publisher` to `gmail-api-push@system.gserviceaccount.com` on the topic — this was the IAM binding that was blocked on labquote-ai
7. Updated `apps/server/.env` locally with new credentials
8. Wiped local Postgres + Redis volumes, re-ran migrations, re-did onboarding flow → consent screen branded "Alfred", callback round-tripped to `/onboarding?step=2`. **Local migration end-to-end verified.**

### Phase 2 — Railway prod deploy

Existing `alfred` Railway project had `server` + `web` services from the m2 deploy (3 weeks ago) but no live DB. Plus a pile of stale offline services from prior attempts.

1. Added `Postgres` service (pgvector pre-installed in Railway's template, confirmed via successful migration of `CREATE EXTENSION vector;`)
2. Added `Redis-E37o` service (Redis name collision with old stale Redis forced the suffix)
3. Wired `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `REDIS_URL=${{Redis-E37o.REDIS_URL}}` references on `server` service
4. Set on server: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (prod), `GOOGLE_PUBSUB_TOPIC=projects/vermithor-485206/topics/gmail-push`
5. Set `VITE_API_URL=https://server-production-c138.up.railway.app` on web
6. Added `.railwayignore` to trim upload size (excluded `references/`, `.warden/`, `.tmp/` — was 161 MB, became ~1 MB)
7. After Railway-side flakiness (multiple "Failed to create TCP proxy" + build push timeouts during an active Railway incident: "Builds are slow to progress"), the GitHub-triggered deploy from PR #14 finally succeeded:
   - Build: 19.5s, 21 dist files, 4.4 MB bundle
   - Image push: 297.7 MB
   - Healthcheck succeeded at `/health` first try
8. Ran migrations against prod Postgres via `railway ssh --service server` → `node /app/node_modules/.pnpm/drizzle-kit@0.31.10/.../bin.cjs migrate --config=/app/packages/db/drizzle.config.ts`. (Drizzle-kit isn't symlinked to `.bin/` in the prod container; had to invoke via direct path.)

---

## Critical follow-ups

### 🔴 1. `RESEND_FROM_EMAIL` is misconfigured on prod — blocks sign-in

```bash
railway variables --service server --kv | grep RESEND_FROM
# Current value: Alfred <yashgouravkar@gmail.com>
```

Resend can't send from `gmail.com` (DMARC blocks it). The verified domain on the Resend account is `croisillies.xyz`. Result: `/api/auth/email-otp/send-verification-otp` returns `{"success":true}` but no email is queued.

Evidence of impact:
- One OTP (`952454`) was delivered at 3:31 PM **from the old deployment** which used `yash@croisillies.xyz` — that one worked
- Every subsequent send (curl + UI) returns success but Resend's "Emails" dashboard shows no new entry beyond 3:31 PM
- The 3:31 PM code is now expired (>10 min)

**Fix:**
```bash
railway variables --service server --set 'RESEND_FROM_EMAIL=Alfred <yash@croisillies.xyz>'
```

Server will auto-redeploy. Then retry sign-in.

**Why this happened:** the prod env was set at m2 (3 weeks ago) and never updated. The first OTP sent today (3:31 PM) actually delivered because the OLD deployment was still serving from a previous successful image with a different/correct env. When the new image went live at 4:26 PM, it picked up the current (broken) env var.

### 🟡 2. Resend free-tier usage check

Even after fixing `RESEND_FROM_EMAIL`, double-check Resend → Settings → Usage. The smoke-test runs from m9/m10 generated ~12 `smoke-*@alfred.local` bounced emails earlier today. Free tier is 100/day; if close to cap, may need to wait or upgrade.

### 🟡 3. Stale services in Railway project — cleanup

Visible offline services from prior attempts that should be deleted:
- `Postgres-adAl` (offline) + `postgres-volume-wBDx`
- `Postgres-ptcS` (was "New 13 Variables and 6 Settings" — half-staged)
- `Postgres-d2zG` (Online, but **unused** — has a volume that may have m2-era data)
- `Postgres` (the new one we added — KEEP)
- `Redis` (old offline) + `redis-volume`
- `Redis-E37o` (the new one we added — KEEP)

Recommend deleting Postgres-adAl, Postgres-ptcS, Postgres-d2zG, and the old Redis. Check Postgres-d2zG's volume first in case it has data worth preserving.

### 🟡 4. Gmail webhook (m7c) still needs activation in prod

`GOOGLE_PUBSUB_TOPIC` is set on server. But to actually receive webhooks:

1. Create a push subscription on the `gmail-push` topic in vermithor:
   - Push endpoint: `https://server-production-c138.up.railway.app/webhooks/gmail`
   - OIDC auth: pick a service account, set audience to e.g. the webhook URL
2. Set on server:
   ```
   GOOGLE_PUBSUB_AUDIENCE=<the audience value>
   GOOGLE_PUBSUB_SERVICE_ACCOUNT=<service account email>
   ```
3. After OAuth-connect a Google account, hit `POST /api/integrations/google/<credentialId>/watch` to install the Gmail watch
4. Update `pending-setup.md` — it currently describes the labquote-ai blocker that no longer applies

In the meantime, the `gmail.poll_sweep` 5-min fallback is active and works.

### 🟢 5. `pending-setup.md` is stale

It describes the labquote-ai blocker as the active situation. Rewrite to reflect:
- m7c migration complete on vermithor (project ID `vermithor-485206`)
- Topic + publisher binding in place
- Only the push subscription + audience env vars remain

### 🟢 6. Dev env mismatch

Local `apps/server/.env` has `RESEND_FROM_EMAIL=yash@croisillies.xyz`. Prod has the broken `Alfred <yashgouravkar@gmail.com>`. Once #1 is fixed, normalize both to the same value.

---

## Key URLs, IDs, paths

```
GCP project ........... vermithor-485206
GCP OAuth client ID ... 307554259025-8i1gtd5m01dtmkrim6i166guu8t2sai7.apps.googleusercontent.com
Pub/Sub topic ......... projects/vermithor-485206/topics/gmail-push

Railway project ....... alfred (ID 0ec1ea83-240d-4306-bf7c-7de61d115b82)
Railway env ........... production (ID 9fbd12bc-6b88-430f-ac88-3ce71b60714b)
Server service ........ ID 822564df-4127-463b-b7ac-6174125951d9
Web service ........... ID 2155bb3b-873d-49c2-a690-e2d58f67dc90
Postgres service ...... ID 05cab70e-e253-4353-a5dc-39376c5ad4d6
Redis-E37o service .... ID 12810bc1-eedd-445a-afa2-f6689e0bb5be

Server URL ............ https://server-production-c138.up.railway.app
Web URL ............... https://web-production-125ee.up.railway.app
```

Railway region: Southeast Asia (1 replica).

---

## Useful commands

```bash
# Link to the alfred project
railway link --project alfred

# Inspect env vars
railway variables --service server --kv

# Set/update env var
railway variables --service server --set 'KEY=value'

# Deploy from local (uploads current dir, respects .gitignore + .railwayignore)
railway up --service server --ci

# Tail server logs
railway logs --service server

# SSH into running container (internal DNS works from here)
railway ssh --service server

# Run migrations against prod Postgres (from inside container, internal DB)
railway ssh --service server -- node /app/node_modules/.pnpm/drizzle-kit@0.31.10/node_modules/drizzle-kit/bin.cjs migrate --config=/app/packages/db/drizzle.config.ts

# psql shell against prod Postgres
railway ssh --service Postgres -- psql -U postgres -d railway
```

---

## What I'd do next, in order

1. **Fix `RESEND_FROM_EMAIL`** (one command above) → wait for auto-redeploy → retry sign-in on https://web-production-125ee.up.railway.app
2. Once signed in, click Connect Google Workspace and verify the prod OAuth round-trip works against vermithor's "Alfred" client
3. If steps 1+2 pass — prod is fully usable. Mark m7c migration complete in `pending-setup.md`.
4. (Optional) clean up the stale Postgres-/Redis services in Railway
5. (Optional, can defer) wire up the Gmail push subscription for sub-5-min webhook latency

If sign-in still fails after #1, debug in this order:
- `railway logs --service server` for the `[auth] Failed to send OTP` log line that the `sendVerificationOTP` callback emits on Resend errors
- Check Resend → Settings → Usage (free tier daily cap)
- Verify `croisillies.xyz` is still verified in Resend → Domains

---

## Stumbling blocks worth remembering

- **Railway TCP-proxy errors and slow builds** were a real Railway incident today, confirmed via in-dashboard banner. Not the project's fault — retry behavior is the only fix.
- **`railway add --database X` flag is needed even when the prompt seems to ignore it.** The interactive prompt displays "What do you need?" but doesn't actually block when run with the flag — the add completes in background despite appearing stuck.
- **`.railwayignore` is real and works** but isn't documented in `railway up --help`. Trimming a 161 MB → 1 MB upload made the difference between repeated timeouts and a clean push during the Railway incident.
- **Drizzle-kit isn't in `.bin/` of the prod container** despite being a devDependency that was used during build. Direct invocation via `.pnpm/drizzle-kit@0.31.10/.../bin.cjs` works.
- **Vite env vars (`VITE_*`) bake in at build time.** Changing `VITE_API_URL` after the web service was built requires a redeploy.
- **Reference variables `${{ServiceName.VAR}}` for hyphenated service names** — `${{Redis-E37o.REDIS_URL}}` works; just include the suffix.
- **Better Auth `sendVerificationOTP` returns success even when Resend silently rejects the from-address.** No exception is thrown for invalid-sender errors at the Resend API layer (returns 200 with an internal queue rejection that doesn't surface).
