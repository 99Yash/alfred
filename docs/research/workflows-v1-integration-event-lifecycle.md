# Workflows v1: integration and event lifecycle research

**Status:** researched 2026-07-22  
**Scope:** Slack, Linear, GitHub, Gmail, and Google Calendar connection and
event-delivery semantics. External facts below come only from provider-owned
documentation. Alfred recommendations are explicitly labeled.

## Executive conclusion

The plan's **author-time hard gate plus pre-run credential recheck is sound for
capability safety**, but it is not a complete readiness test for event-triggered
workflows. An integration can have a usable token while its watch has expired,
its webhook has been disabled, deliveries have been rate-limited or lost, or
its recovery cursor has gone stale. Gmail requires watch renewal at least every
seven days, Google Calendar notification channels expire, Slack describes its
Events API as best-effort, GitHub does not automatically redeliver failed
webhooks, and Linear may disable a repeatedly failing endpoint
([Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push#renewing_mailbox_watch),
[Calendar push guide](https://developers.google.com/workspace/calendar/api/guides/push),
[Slack Events API](https://docs.slack.dev/apis/events-api/),
[GitHub failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
[Linear webhooks](https://linear.app/developers/webhooks)).

**Alfred recommendation:** retain the hard author-time gate, but split readiness
into two independently observable contracts:

1. `capability_ready`: credential refresh succeeds, required scopes and resource
   access remain present, and a live tool surface exists.
2. `trigger_ready`: the required subscription/channel exists, is not near
   expiration, its receiver is healthy, and its recovery cursor/checkpoint is
   usable.

For cron/manual workflows, only the first contract is required. For event
workflows, both must pass before persistence/activation. The existing pre-run
check should remain for capability safety, while renewal, delivery-health, and
cursor recovery must run continuously because a missing event creates no run in
which to perform a pre-run check.

The plan's stronger claim—**no generic content sync or vector engine is needed
for workflows v1**—survives, with one qualification: Alfred does need a small
generic **event-receipt ledger and subscription-health control plane**. Provider
change capture and recovery remain provider-specific. Materialize exact,
minimal state only after a workflow proves that it needs state across runs;
vectors are useful only for semantic recall over content, never for credential
health, deduplication, cursors, or authoritative object lifecycle.

## What the hard gate should mean

### Provider facts

Tokens have different lifecycle semantics. Slack can test a token with
`auth.test`; failure responses distinguish invalid, expired, and revoked tokens,
and Slack can also emit `tokens_revoked` and `app_uninstalled` events. The order
of Slack's uninstall and token-revocation events is explicitly not guaranteed
([Slack `auth.test`](https://docs.slack.dev/reference/methods/auth.test),
[Slack `tokens_revoked`](https://docs.slack.dev/reference/events/tokens_revoked/),
[Slack `app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled/)).
Slack token rotation, when enabled, gives access tokens a 12-hour life and uses
single-use refresh tokens with a short grace period
([Slack token rotation](https://docs.slack.dev/authentication/using-token-rotation/)).

Linear access tokens are valid for 24 hours and rotate with refresh tokens; a
refresh request can be replayed for 30 minutes if the response containing the
new refresh token is lost. A lightweight authenticated `viewer` query is
available. Deauthorizing an OAuth app emits an `OAuthApp revoked` webhook
([Linear OAuth](https://linear.app/developers/oauth-2-0-authentication),
[Linear GraphQL](https://linear.app/developers/graphql),
[Linear webhooks](https://linear.app/developers/webhooks)).

GitHub App user tokens expire after eight hours by default and their refresh
tokens after six months; a revoked user authorization emits the mandatory
`github_app_authorization` webhook, and continued use returns `401 Bad
Credentials`. GitHub also sends mandatory `installation` and
`installation_repositories` events for installation and repository-access
changes
([GitHub token refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens),
[GitHub authorization and installation events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#github_app_authorization)).
Installation access tokens expire after one hour
([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#expire-tokens)).

Google requires clients to anticipate refresh tokens becoming unusable because
of user revocation, six months of disuse, password changes when Gmail scopes are
present, token-count limits, time-bounded grants, or admin policy. A refresh
failure may return `invalid_grant`, after which the user must authenticate again
([Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2#expiration),
[Google web-server OAuth errors](https://developers.google.com/identity/protocols/oauth2/web-server#handlingresponse)).

### Alfred recommendations

- Treat stored expiry timestamps as scheduling hints, not proof of health.
  Refresh just in time through the existing token owner and classify terminal
  refresh/auth failures as `needs_reauth`; do not make a provider API probe on
  every scheduler tick.
- Persist capability requirements more precisely than provider slug when the
  workflow depends on them: provider, required OAuth scopes/permissions,
  installation/workspace/account identity, and any resource-access boundary
  such as selected GitHub repositories or a Linear workspace.
- Consume revocation/uninstall/access-change events as fast invalidation signals,
  but keep request-time refresh/API errors authoritative. A webhook may itself
  be missed.
- Author-time validation should provision or verify the required trigger before
  activation. "Gmail connected" must not satisfy a `gmail-event` workflow when
  its Pub/Sub/watch setup cannot be established.
- On a terminal pre-run failure, pause and notify as the plan proposes. On a
  transient provider outage or rate limit, mark the run `deferred` and retry
  within a bounded policy rather than converting a temporary fault into reauth.

## Event lifecycle by provider

### Slack

#### Provider facts

Slack Events API subscriptions are configured for selected event types and are
delivered either to an HTTP Request URL or through Socket Mode. HTTP setup
includes a URL-verification challenge, and event payloads carry an `event_id`
that is globally unique across workspaces
([Slack HTTP Request URLs](https://docs.slack.dev/apis/events-api/using-http-request-urls/),
[Slack Events API](https://docs.slack.dev/apis/events-api/)).

For HTTP delivery, Slack expects a successful response within three seconds and
retries a failed request up to three times: nearly immediately, after one
minute, and after five minutes. Retry attempts include
`x-slack-retry-num` and `x-slack-retry-reason`. If more than 95% of deliveries
fail over 60 minutes, subscriptions can be temporarily disabled; apps receiving
fewer than 1,000 events per hour are exempt from automatic disabling. Slack's
optional Delayed Events setting extends retries hourly for 24 hours; otherwise
the Events API is best-effort and by default does not attempt events delayed by
more than two hours
([Slack Events API error handling](https://docs.slack.dev/apis/events-api/#error-handling)).

Slack limits Events API delivery to 30,000 events per workspace, per app, per
60 minutes and emits `app_rate_limited` during capped minutes. Web API limits
are per method, workspace, and app; a `429` response includes `Retry-After`
([Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)).

#### Alfred recommendations

- Deduplicate the durable ingress write by `(provider, event_id)` before
  acknowledging; enqueue interpretation after the receipt is durable.
- Track subscription state and the timestamp of the latest verified delivery,
  plus `app_rate_limited` and disablement incidents. There is no documented
  generic Events API change cursor comparable to Gmail history or Calendar sync
  tokens, so missed-event recovery must be workflow-specific: reconcile the
  affected Slack objects through live Web API reads where scopes permit, or
  record an explicit coverage gap.
- Do not mirror or vectorize all Slack. A "when I am mentioned, do X" workflow
  needs only the triggering payload plus execution audit. A recurring semantic
  digest over months of messages may justify a bounded message corpus and
  embeddings, but that is a proven retrieval requirement, not trigger plumbing.

### Linear

#### Provider facts

An OAuth application's webhook configuration can cause Linear to create a
webhook for every authorizing organization. Webhooks may cover all public teams
or one team; only workspace admins or OAuth apps with `admin` scope can create
or read webhook records
([Linear webhooks](https://linear.app/developers/webhooks)).

Linear requires an HTTPS endpoint to return `200` within five seconds. A failed
delivery is retried at one minute, one hour, and six hours; continued failure
may disable the webhook until it is manually re-enabled. `Linear-Delivery` is a
unique UUID for the payload. Data-change payloads include the serialized subject
entity and, for updates, prior values for changed properties
([Linear webhooks](https://linear.app/developers/webhooks)).

Linear discourages polling for updates and recommends webhooks. OAuth apps have
a 5,000-request-per-hour request budget per user/app user, plus query-complexity
and endpoint-specific limits exposed in response headers; rate-limit errors use
the GraphQL `RATELIMITED` code
([Linear rate limiting](https://linear.app/developers/rate-limiting)).

#### Alfred recommendations

- Deduplicate by `Linear-Delivery`. Treat `webhookTimestamp` as event metadata,
  not an ordering guarantee; reducers should prefer the entity's native
  `updatedAt`/version and fetch current state when an older delivery could
  overwrite newer state.
- Track the expected organization/team coverage and whether the webhook is
  enabled. Because the provider documents finite retries and possible
  disablement but no general replay cursor, recovery should reconcile only the
  object kinds demanded by active workflows, using `updatedAt` filters or
  targeted object reads where supported.
- The serialized payload is enough for many one-shot workflows. Materialize a
  small exact issue/project projection only for workflows that span lifecycle
  transitions (for example, "remind me until issue X is done"). Full-workspace
  mirroring and embeddings are unnecessary unless a later workflow proves a
  cross-issue semantic-search need.

### GitHub

#### Provider facts

GitHub recommends responding to webhooks with `2xx` within ten seconds and
processing asynchronously. Each delivery has a globally unique
`X-GitHub-Delivery`; a requested redelivery retains the same value
([GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)).
Webhook payloads are capped at 25 MB, and GitHub does not deliver a payload when
an event exceeds that cap
([GitHub webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap)).

GitHub does **not** automatically redeliver failed webhooks. GitHub documents a
recovery loop that lists deliveries, detects non-`OK` outcomes, and requests
redelivery; deliveries can be redelivered only from the past three days
([GitHub failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
[GitHub redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)).

REST primary limits are generally 5,000 requests per hour for an authenticated
user and at least 5,000 per hour for a GitHub App installation, with scaling for
larger non-Enterprise installations and 15,000 per hour for Enterprise Cloud
organizations. GitHub also enforces secondary concurrency, points, CPU, and
content-creation limits. Primary state is exposed in `x-ratelimit-*` headers;
`403`/`429`, `retry-after`, and reset headers govern retry timing
([GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).

#### Alfred recommendations

- Keep the existing `(provider, X-GitHub-Delivery)` receipt dedup. Add a periodic
  failed-delivery auditor within the three-day recovery window; after that
  window, reconcile the exact object sets used by active workflows through REST
  or GraphQL.
- Never make delivery order a correctness dependency. Fold each object using
  provider timestamps/current API state and monotonic lifecycle rules. A payload
  cap or missed delivery is another reason that absence must never imply
  closure.
- GitHub is the strongest case for exact materialization already captured by
  Alfred's `integration_objects`: PR/issue/check identity, native and normalized
  state, key aliases such as head SHA, title/URL, and relevant relations. That
  projection enables multi-run lifecycle workflows. Keep source text and vectors
  out of authoritative merge/close decisions; use live calls for uncached detail
  and all mutations.

### Gmail

#### Provider facts

`users.watch` returns a current `historyId` and an expiration timestamp. Gmail
requires calling `watch` at least once every seven days and recommends daily
renewal. Notifications contain the mailbox address and a new history ID, not the
changed message itself; clients use `history.list` from their last cursor to get
change details
([Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push)).

Push notifications must be acknowledged; unacknowledged Pub/Sub pushes are
retried. Gmail caps notifications for each watched user at one event per second
and drops excess notifications. Google also says notifications can be delayed or
dropped and recommends periodic `history.list` fallback
([Gmail push limitations](https://developers.google.com/workspace/gmail/api/guides/push#limitations)).
History is typically retained for at least a week but can be shorter; an
out-of-range `startHistoryId` returns `404` and requires a full sync
([Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)).

Gmail quotas are measured in units: currently 1,200,000 units per project per
minute and 6,000 per user per project per minute; `history.list` costs 2,
`messages.list` 5, `messages.get` 20, and `watch` 100 units. Google recommends
truncated exponential backoff for time-based quota failures
([Gmail usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)).

#### Alfred recommendations

- Persist per credential: watch expiration, last successful renewal, last
  applied history ID, last notification time, and last successful fallback
  sweep. Renew daily with jitter and alert before expiration.
- Treat a notification as a wake-up hint, coalesce bursts by credential, and
  advance the history cursor only after all pages/derived writes are durable.
  On `404`, run a bounded full reconciliation for the labels/time horizon needed
  by active workflows.
- Gmail event workflows need a durable exact message/thread record when later
  runs must refer to the same mail, perform triage, or detect replies. Store
  provider IDs, thread ID, history ID, selected headers/labels, dates, and only
  the content demanded by the workflow. Embeddings are justified for semantic
  recall over email content, but not for event delivery or exact reply/label
  state. A one-shot "on mail from X, notify me" workflow can operate from a live
  fetch plus a minimal processed-message/dedup row.

### Google Calendar

#### Provider facts

Calendar creates a notification channel per watched resource. A channel can
expire according to the requested time or a stricter provider limit, and renewal
is performed by creating a new channel; Google notes that old and new channels
can overlap. Notifications have no body, so the client must call the API for
change details
([Calendar push guide](https://developers.google.com/workspace/calendar/api/guides/push)).

Every channel starts with a `sync` notification numbered `1`; later
`X-Goog-Message-Number` values increase but are not sequential. Incremental sync
starts with a full collection read and persists `nextSyncToken`; a `410 Gone`
means the token is invalid and requires clearing the local collection and
performing a new full sync
([Calendar push message format](https://developers.google.com/workspace/calendar/api/guides/push#receive-notifications),
[Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)).

Calendar currently allows 10,000 requests per project per minute and 600 per
user per project per minute, calculated with a sliding window; quota failures
return `403` or `429`, and Google recommends exponential backoff, randomized
traffic, and push notifications
([Calendar usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)).

#### Alfred recommendations

- Persist channel ID, resource ID, expiration, channel token hash, calendar ID,
  sync token, renewal status, and latest message number. Deduplicate on
  `(channel_id, message_number)` but do not interpret gaps as a count of missing
  events because numbers are explicitly non-sequential.
- Renew before expiry with overlap, accept both channels during the overlap, and
  converge them on one calendar sync token. A notification should enqueue one
  coalesced incremental sync, not one workflow run per webhook.
- Materialize only the exact event window required for proactive workflows
  (event/recurrence identity, revisions, start/end, attendees, status, meeting
  link, and workflow provenance). Calendar notifications cannot themselves
  trigger a semantically correct workflow without this live/incremental read.
  Vectors add little for scheduling/state; consider them only if users later ask
  for semantic recall across descriptions or notes.

## Minimal primitives Alfred actually needs

These are Alfred recommendations, not provider requirements.

### 1. Connection capability record

Keep the existing integration credential as token owner, but expose a normalized
snapshot with `provider`, account/workspace/installation identity, granted
scopes/permissions, resource access, token expiry/refresh status,
`last_verified_at`, and terminal/transient failure classification.

### 2. Subscription record

One row per provider subscription/channel/watch, linked to the credential, with
provider-native IDs, scope/resource selector, status, expiration/renew-before,
last successful setup/renewal, and last verified delivery. Slack/Linear/GitHub
may be long-lived configuration; Gmail/Calendar are renewable leases.

### 3. Durable event receipt

Use a generic envelope—provider, provider delivery ID, subscription, received
time, signature-verification result, event type, payload hash/raw payload or
pointer, processing status—and a unique key on provider delivery identity. This
is not a generic sync engine; it is the minimum replay/audit boundary required
by retried webhooks.

### 4. Provider cursor/checkpoint

Keep provider-native recovery state without pretending it is uniform: Gmail
`historyId`, Calendar `syncToken`, GitHub delivery-audit high watermark, and
workflow-specific reconciliation checkpoints for Slack/Linear. A common table
or interface is reasonable; cursor interpretation must stay in provider code.

### 5. Demand-driven projection

Create a materialized projection only when a proven workflow needs one of these:

| Workflow need                 | Read strategy                       | Durable state                                            |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------- |
| One-shot event reaction       | Event plus live fetch               | Receipt, processed key, run audit                        |
| Current answer or mutation    | Live provider call                  | Operation audit; no mirror by default                    |
| Lifecycle across runs         | Exact keyed projection              | Native ID/state/version/title/URL and relevant relations |
| Missed-event recovery         | Provider delta/reconciliation       | Cursor plus minimal object checkpoint                    |
| Semantic recall over a corpus | Indexed content, optionally vectors | Only the selected content/horizon proven useful          |

Do not select vectors because an integration has text. Select vectors only when
the product query is fuzzy semantic retrieval. Do not select a full mirror
because webhooks exist. Select an exact projection when correctness depends on
state surviving beyond a payload window or being joined across runs.

## Consequences for `workflows-v1.md`

1. **Keep** the hard author-time refusal for missing/reauth/no-tool-surface
   capabilities.
2. **Strengthen** event authoring: persist/activate only after trigger
   provisioning succeeds; persist the subscription requirement alongside
   `required_capabilities`.
3. **Keep** the pre-run capability recheck, but do not describe it as sufficient
   runtime health. Add continuous subscription renewal and delivery/cursor
   monitoring outside workflow execution.
4. **Keep** interpreted execution and live tools for cron/manual and low-frequency
   event workflows. Webhook ingestion should acknowledge quickly and enqueue;
   it should not run the full interpreted workflow inline.
5. **Keep** "no general sync/indexing engine" if it means no speculative object
   mirror or universal embedding corpus. Explicitly allow the small generic
   receipt/subscription/cursor substrate above and provider-specific recovery.
6. **Keep and sharpen** demand-driven `integration_objects`: exact lifecycle
   projection for proven multi-run workflows; live calls for current detail;
   vectors only for proven semantic retrieval.
7. Add two honest outcomes to run/operations reporting: `paused_needs_reauth`
   and `trigger_degraded`/`coverage_gap`. A workflow must not claim "nothing
   happened" when Alfred cannot prove the event stream was complete.

## Suggested acceptance tests

These are Alfred recommendations.

- Authoring an event workflow fails without both capability and successfully
  provisioned trigger readiness; no active row is left behind after partial
  provisioning.
- A revoked token event and a request-time terminal auth failure both converge
  idempotently on `needs_reauth` and pause dependent workflows.
- Gmail and Calendar renewal occurs before expiry; overlapping Calendar channels
  do not double-run a workflow.
- Replayed Slack, Linear, GitHub, Gmail Pub/Sub, and Calendar deliveries create
  one durable event effect and at most one workflow run.
- An out-of-order object update cannot regress materialized state.
- Gmail `404` and Calendar `410` trigger bounded full reconciliation; absence of
  a webhook never closes an external object.
- GitHub's failed-delivery auditor requests redelivery inside three days and
  falls back to object reconciliation outside that window.
- Slack `app_rate_limited`, Linear webhook disablement, expired watches, and
  stale cursors surface `trigger_degraded`; they do not masquerade as a healthy
  workflow with zero matching events.
- Rate-limit tests honor provider reset/`Retry-After` semantics and do not pause
  a workflow as if reauthorization were required.
