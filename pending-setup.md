# Pending external setup

External configuration that gates infra activation. Code paths all
exist; just flip the env vars + run the listed commands when the
external dependency is unblocked.

Last verified: 2026-05-20.

---

## Gmail push notifications (m7c — webhook + Pub/Sub)

**Status:** ✅ Active in production.

The labquote-ai blocker (yashgouravkar@gmail.com lacked
`pubsub.topics.setIamPolicy` on Sedat's project) was resolved by
migrating to the user's own GCP project `vermithor-485206` (display
name "Alfred"). All steps below are complete:

- Topic `projects/vermithor-485206/topics/gmail-push` exists, with
  `roles/pubsub.publisher` granted to
  `gmail-api-push@system.gserviceaccount.com`.
- OAuth web client "Alfred" (client ID
  `307554259025-8i1gtd5m01dtmkrim6i166guu8t2sai7`) authorises both
  `localhost:3000`/`localhost:3001` and the prod `alfred.beauty` /
  `api.alfred.beauty` origins + redirect URIs.
- Push subscription `gmail-push-prod` delivers to
  `https://api.alfred.beauty/webhooks/gmail` with OIDC auth, signed by
  `gmail-push-pusher@vermithor-485206.iam.gserviceaccount.com` and
  the same URL as the audience.
- Server env in prod (Railway service `server`):
  ```
  GOOGLE_OAUTH_CLIENT_ID=307554259025-8i1gtd5m01dtmkrim6i166guu8t2sai7.apps.googleusercontent.com
  GOOGLE_OAUTH_CLIENT_SECRET=<set>
  GOOGLE_OAUTH_REDIRECT_URI=https://api.alfred.beauty/api/integrations/google/callback
  GOOGLE_PUBSUB_TOPIC=projects/vermithor-485206/topics/gmail-push
  GOOGLE_PUBSUB_AUDIENCE=https://api.alfred.beauty/webhooks/gmail
  GOOGLE_PUBSUB_SERVICE_ACCOUNT=gmail-push-pusher@vermithor-485206.iam.gserviceaccount.com
  ```
- The Gmail watch is installed on the currently connected credential
  (renews on the 7-day cycle via `gmail.watch_renew`).

If a new credential gets connected later, install the watch with:

```sh
curl -X POST -b cookies.txt \
  https://api.alfred.beauty/api/integrations/google/<credentialId>/watch
```

The 5-minute `gmail.poll_sweep` fallback stays active as a safety net.

---

## Local-dev push (optional)

The prod webhook eliminates the prior need for ngrok against
`localhost:3001` — Pub/Sub now pushes to `api.alfred.beauty` and the
worker on Railway picks it up. Local dev can still hit Gmail directly
via OAuth + the poll fallback. If you ever want push delivery into a
local server, create a second Pub/Sub subscription on the same topic
with an ngrok endpoint; the topic supports multiple subscribers.
