# Pending external setup

External configuration that's blocking infra activation. Code paths
all exist; just flip the env vars + run the listed commands when the
external dependency is unblocked.

---

## Gmail push notifications (m7c — webhook + Pub/Sub)

**Status:** Code complete. Activation deferred — currently running on
the 5-minute polling fallback (`gmail.poll_sweep` repeatable job),
which is fine for development but adds up to 5 min of email-sync lag
vs the ~instant push channel.

### What's blocking

`yashgouravkar@gmail.com` has hit Google's per-account project quota.
Even after deleting unused projects, deleted projects count toward the
quota for ~30 days, so a fresh personal project can't be created. The
existing `labquote-ai` project (currently configured for OAuth) only
grants this account `roles/editor`, which lacks
`pubsub.topics.setIamPolicy` — so we can't grant the Gmail service
account the publisher role on a topic in that project either.

### What's already done

- Topic `projects/labquote-ai/topics/gmail-push` was created during
  the m7c attempt. It's harmless — leave it or delete it (delete via
  console, since gcloud lacks the IAM perm to manage it).
- `react-course-1de35` was deleted during the same attempt.

### What's needed to activate

Pick **one** path:

1. **Find someone with Owner on `labquote-ai`** and have them run:
   ```sh
   gcloud pubsub topics add-iam-policy-binding gmail-push \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher \
     --project=labquote-ai
   ```

2. **Wait ~30 days** for deleted-project undelete window to expire,
   then create a fresh project where you'll be Owner. Steps from
   that point:
   1. `gcloud projects create alfred-yk-pers --name=Alfred`
   2. Enable Gmail API + Pub/Sub API on the new project
   3. Create OAuth consent screen (External user type) + add the
      five scopes from `packages/integrations/src/google/oauth.ts`
   4. Create OAuth web client; redirect URI
      `http://localhost:3001/api/integrations/google/callback`
   5. Create topic + grant publisher (gcloud command above, swapping
      the project)
   6. Update `apps/server/.env`:
      ```
      GOOGLE_OAUTH_CLIENT_ID=<new client id>
      GOOGLE_OAUTH_CLIENT_SECRET=<new client secret>
      GOOGLE_PUBSUB_TOPIC=projects/<new-project>/topics/gmail-push
      ```

3. **Request quota increase** via GCP support — slowest, may take
   days, but would unblock path 2 immediately.

### What still needs setup once Pub/Sub topic exists

These apply regardless of which project hosts the topic:

1. **Push subscription** on the topic, push endpoint
   `https://<your-public-server>/webhooks/gmail`. Set OIDC auth:
   pick a service account, set `audience` to a value of your
   choosing (e.g. the webhook URL itself). Set:
   ```
   GOOGLE_PUBSUB_AUDIENCE=<the audience>
   GOOGLE_PUBSUB_SERVICE_ACCOUNT=<service account email>  # optional defense
   ```
2. **Public URL** for the webhook. For local dev, ngrok against
   `localhost:3001`. For prod, the deployed Railway URL.
3. **Install the watch** — once a Google account is connected via
   OAuth and `GOOGLE_PUBSUB_TOPIC` is set, hit:
   ```sh
   curl -X POST -b cookies.txt http://localhost:3001/api/integrations/google/<credentialId>/watch
   ```

After that, `gmail.poll_history` jobs will fire from webhooks
within seconds instead of waiting on the 5min sweep.
