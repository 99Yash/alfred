# Sentry push surface & autofix — build-vs-buy for an "error → cloud agent → PR" loop

**Question:** For an autonomous "Sentry error → cloud coding agent → PR" loop, what are the
primary-source facts on (1) Sentry's outbound push surface and (2) whether Sentry already ships
this loop itself?

**Consumer context (informs the final section only):** a Node 22 Elysia API on Railway
(unprivileged container, public HTTPS domain), an existing GitHub App installation (installation
tokens available), and an existing `webhook_events` table that dedups on a provider delivery UUID
via `on conflict do nothing`.

**Date:** 2026-07-25. All facts below are from primary sources — `docs.sentry.io` (fetched as raw
`.md` where available), `sentry.io/pricing` and `sentry.io/changelog`, and `github.com/getsentry/*`
(source code, README, GitHub issues) — with URLs inline. No blogs, aggregators, or secondary
write-ups are cited.

---

## Executive summary — verdicts

| #   | Topic                                                            | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Key citation                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Internal Integration webhooks                                    | **One unified mechanism.** Registered at Settings → Developer Settings; 8 subscribable resources (`installation`, `event_alert`, `issue`, `metric_alert`, `error`, `comment`, `seer`, `preprod_artifact`); 5 documented headers (`Content-Type`, `Request-ID`, `Sentry-Hook-Resource`, `Sentry-Hook-Timestamp`, `Sentry-Hook-Signature`); HMAC‑SHA256 over the exact body bytes with the Client Secret; **`error.created` is Business/Enterprise‑only**; no retry-count is documented, but Sentry's own task config retries `3× / 5 min apart / network-failures-only`, and a 2023 changelog auto‑unsubscribes a webhook after 1000 timeouts in 24h.                                                                   | [webhooks.md](https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md), [errors.md](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/)                                                |
| 2   | Alert-rule "webhook" action vs Internal Integration subscription | **Not two mechanisms — one.** An alert rule's webhook action is `Send a notification via <your Internal/Public Integration>`; it fires **per alert-condition-match** (`event_alert`, action always `triggered`), distinct from `error` (**per individual error event**, paid-only) and `issue` (**per lifecycle transition**, and only for `OUTAGE`/`ERROR`/`FEEDBACK` categories). **There is NO retry-stable delivery ID.** The `Request-ID` header is `uuid4().hex` minted fresh inside each retried task, so a redelivery of the same event carries a _different_ `Request-ID` — it is **unusable as an idempotency key**. Dedup must be a synthetic key on payload identity (`event_id`, or `issue.id`+`action`). | [app_platform_event.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py), [webhooks.md](https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md) |
| 3   | Seer / Autofix                                                   | **Already covers the full loop, with real gaps.** GA feature: automatic trigger (10+ events, <14 days old, ML fixability score), root cause → solution → code‑gen → **real PR opened on GitHub/GitLab.com**, configurable automation ceiling, and a `seer.pr_created` **webhook** carrying the PR URL/number on completion. Gaps: GitHub/GitLab.com-cloud only, no documented trigger API, custom-coding-agent handoff limited to 3 named integrations, billed per active contributor ($40/mo) on top of Team/Business.                                                                                                                                                                                                | [autofix.md](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/), [seer webhook](https://docs.sentry.io/integrations/integration-platform/webhooks/seer/)                                                                        |
| 4   | Official MCP server                                              | **Exists, GA, hosted + self-hostable.** `https://mcp.sentry.dev/mcp`, Streamable HTTP/SSE (Cloudflare remote-MCP) + WIP stdio; OAuth (remote) or User Auth Token (stdio); 48 tools across 5 "skills" (`inspect`, `seer`, `docs`, `triage`, `project-management`); source-available under FSL-1.1-Apache-2.0, self-hostable via `npx @sentry/mcp-server`.                                                                                                                                                                                                                                                                                                                                                               | [getsentry/sentry-mcp README](https://github.com/getsentry/sentry-mcp)                                                                                                                                                                  |
| 5   | REST API for issue detail                                        | **All four resources exist and are documented, except suspect commits.** Issue: `GET /issues/{issue_id}/`. Latest event w/ stack trace + source context: `GET /issues/{issue_id}/events/{event_id}/` (`latest`\|`oldest`\|`recommended`), context lines included by default. Tags: `GET /issues/{issue_id}/tags/{key}/values/`. **Suspect commits: no public endpoint** — the real endpoint (`EventFileCommittersEndpoint`) is marked `ApiPublishStatus.PRIVATE` in source. Auth = one of Organization Tokens (CI-oriented, fixed scope), Internal Integration tokens (customizable), or Personal/User tokens. Rate limits are per-caller-per-endpoint, fixed-window + concurrent, exact numbers not published.        | [retrieve-an-issue-event](https://docs.sentry.io/api/events/retrieve-an-issue-event/), [event_file_committers.py](https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/event_file_committers.py)                    |

---

## 1. Sentry Internal Integrations (webhooks)

### Registration path

Creating the integration that owns the webhook URL: "In [sentry.io], navigate to **Settings >
Developer Settings**. From here, you can choose to create an internal or public integration.
Internal integrations can only be used by your organization, whereas public integrations can be
published and are available for all Sentry users." — [Integration Platform](https://docs.sentry.io/integrations/integration-platform.md).
"In order to receive webhook events, you must specify the webhook URL when creating an
integration. After you've specified the webhook URL, you'll be able to toggle on 'Alert Action'
and create alerts that send notifications to your integration." (same page).

### Subscribable resources

Per [Webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md),
the `Sentry-Hook-Resource` header can be one of exactly: `installation`, `event_alert`, `issue`,
`metric_alert`, `error`, `comment`, `seer`, `preprod_artifact`. Each has its own sub-page
(e.g. [Issues](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/),
[Errors](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/),
[Comments](https://docs.sentry.io/integrations/integration-platform/webhooks/comments/)). A
documented restriction on `issue`: "The issue categories we currently support `issue.created`
webhooks for are `OUTAGE`, `ERROR`, and `FEEDBACK`" — [Issues](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/).

### Payload envelope

Every webhook shares four top-level keys, per the same page:

- `action` — "The action that corresponds with the resource in the header. For example, if the
  resource is `issue` the action could be `created`."
- `installation` — "An object with the `uuid` of the installation so that you can map the webhook
  request to the appropriate installation."
- `data` — "contains information about the resource and will differ in content depending on the
  type of webhook."
- `actor` — "who, if anyone, triggered the webhook" — a user, the integration itself
  (`type: "application"`), or `"Sentry"` for automatic actions.

Resource-specific shapes (verbatim example payloads):

- `error` (action always `created`): full error object under `data.error` — `event_id`, `culprit`,
  `exception.values[].stacktrace.frames[]` (with `pre_context`/`post_context`/`context_line`),
  `tags[]`, `issue_id`, `issue_url`, `web_url`, `project` id. — [errors.md](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/)
- `issue` (action ∈ `created`, `resolved`, `assigned`, `archived`, `unresolved`): `data.issue` with
  `id`, `shortId`, `title`, `culprit`, `status`, `project{id,name,slug}`, `assignedTo`, etc. —
  [issues.md](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- `comment` (action ∈ `created`, `updated`, `deleted`): `comment`, `project_slug`, `comment_id`,
  `issue_id`, `timestamp`. — [comments.md](https://docs.sentry.io/integrations/integration-platform/webhooks/comments/)
- An alert action's own user-configured routing settings (e.g. a channel or team picked when the
  alert was created) ride along inside the alert payloads at `data.issue_alert.settings` (Issue
  Alert), `data.metric_alert.alert_rule.triggers[].actions[].settings` (Metric Alert), or
  `data.alert.settings` (Activity Alert) — [Alert Action](https://docs.sentry.io/integrations/integration-platform/ui-components/alert-action/).

### Request headers

Five headers are documented on every webhook request, per
[webhooks.md](https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md):
`Content-Type` ("identifies the media type of the payload as JSON format"), `Request-ID`
("provides a unique identifier for tracking and debugging specific events"),
`Sentry-Hook-Resource`, `Sentry-Hook-Timestamp`, and `Sentry-Hook-Signature`.

Sentry's source confirms exactly how all five are produced, in one `cached_property` on
`AppPlatformEvent` —
[app_platform_event.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py)
(branch `master`, fetched 2026-07-25):

```python
@cached_property
def sentry_headers(self) -> dict[str, str]:
    request_uuid = uuid4().hex
    return {
        "Content-Type": "application/json",
        "Request-ID": request_uuid,
        "Sentry-Hook-Resource": self.resource,
        "Sentry-Hook-Timestamp": str(int(time())),
        "Sentry-Hook-Signature": self.install.sentry_app.build_signature(self.body),
    }
```

So `Request-ID` is a **random UUID4 with no derivation from the event**, and
`Sentry-Hook-Timestamp` is **Unix seconds at send time** (not a stable event timestamp). The
docstring states the caching scope precisely: "Cached so the Request-ID, timestamp, and signature
are computed once and stay consistent **between the sent request and the logged buffer entry**" —
i.e. consistency is guaranteed only within a single send, not across retries. See §2.

**Undocumented bonus capability (source-only):** a Sentry App may carry user-configured
`webhook_headers` (parsed from `Name: Value` strings) that are merged into every request, with
Sentry's own headers merged _last_ so "a custom header can never override the signature and spoof
payload integrity" — [app_platform_event.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py),
[headers.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/utils/headers.py).
This is **not documented on `docs.sentry.io`** (searched the webhooks and internal-integration
pages and `docs.sentry.io` generally for custom webhook headers — no hit), so treat it as
unsupported surface even though it exists.

### Signature

"This header [`Sentry-Hook-Signature`] represents a cryptographic hash generated by your _Client
Secret_. Its primary purpose is to make sure the request is authentic and comes from Sentry
servers." The documented verification snippet:

```javascript
const crypto = require("crypto");
function verifySignature(request, secret = "") {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(JSON.stringify(request.body), "utf8");
  const digest = hmac.digest("hex");
  return digest === request.headers["sentry-hook-signature"];
}
```

— i.e. **HMAC-SHA256**, keyed with the internal integration's **Client Secret**. Source:
[webhooks.md](https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md).

The docs' JS sample re-serializes the _parsed_ body (`JSON.stringify(request.body)`), which is only
correct by coincidence of matching serializers. Sentry's own implementation signs **the exact byte
string it transmits**: `build_signature` is `hmac.new(key=client_secret.encode("utf-8"),
msg=body.encode("utf-8"), digestmod=sha256).hexdigest()` over `AppPlatformEvent.body`, which is
`json.dumps(...)`, and that same value is passed as the request payload
(`safe_urlopen(data=app_platform_event.body, ...)`). Sources:
[sentry_app.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/models/sentry_app.py),
[app_platform_event.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py),
[webhooks.py](https://github.com/getsentry/sentry/blob/master/src/sentry/utils/sentry_apps/webhooks.py).
**Therefore a consumer must HMAC the raw request body bytes**, not a re-serialized object — any
key-order or whitespace divergence from Python's `json.dumps` breaks verification.

### Timeout

"Webhooks should respond within 1 second. Otherwise, the response is considered a timeout." — same
page.

### Retry/redelivery

**Not documented as a retry policy on any `docs.sentry.io` product page checked** (`webhooks.md`,
`errors.md`, `issues.md`, `comments.md`, `integration-platform.md` — none mention a retry count or
backoff). Two separate primary sources fill this gap:

1. **Task-level retry (source code).** Every webhook-sending Celery task in
   `github.com/getsentry/sentry` (`src/sentry/sentry_apps/tasks/sentry_apps.py`, branch `master`,
   fetched 2026-07-25) — `send_alert_webhook_v2` (the `event_alert` sender),
   `send_resource_change_webhook`/`process_resource_change_bound` (the `issue`/`error` senders),
   and `installation_webhook` — is declared identically:
   ```python
   retry=Retry(
       times=3,
       delay=60 * 5,
       on=_SENTRY_APP_WEBHOOK_RETRY_ON,
       ignore=_SENTRY_APP_WEBHOOK_RETRY_IGNORE,
   ),
   ```
   where `_SENTRY_APP_WEBHOOK_RETRY_ON = (RequestException, InnerTimeoutError)` and
   `_SENTRY_APP_WEBHOOK_RETRY_IGNORE = (ClientError, SentryAppSentryError, AssertionError,
ValueError, RestrictedIPAddress)`. So: **3 retries, 5 minutes apart, triggered only by
   network-level failures or timeouts — a 4xx application-level rejection (`ClientError`) is
   explicitly NOT retried.** Source: [sentry_apps.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/tasks/sentry_apps.py),
   [webhooks.py](https://github.com/getsentry/sentry/blob/master/src/sentry/utils/sentry_apps/webhooks.py)
   (the latter also implements a per-integration **circuit breaker** that halts a chronically
   failing webhook and emails the app owner — `_create_circuit_breaker`, `_notify_webhook_disabled`).
2. **Product-level failure handling (changelog).** A dated Sentry changelog entry documents the
   longer-horizon consequence of repeated timeouts, distinct from the task retry above: "If a
   webhook has **1000 timeouts within 24 hours**, the webhook will be **unsubscribed** from
   receiving events," with the exception that "this limitation does not apply for published
   integrations built by partners." — [2023-10-3 changelog](https://sentry.io/changelog/2023-10-3-change-to-integration-platform-webhook-handling/).

### Plan gating / volume limits

"This feature is available only if your organization is on a Business or Enterprise plan." —
[errors.md](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/), i.e.
**`error.created` (per-event, not per-issue) webhooks require Business or Enterprise.**
`sentry.io/pricing` structured pricing data lists **Team $29/mo, Business $89/mo** billed monthly
(**$26/mo, $80/mo** billed annually) as of 2026-07-25 — [Pricing](https://sentry.io/pricing/). No
sampling/rate-limiting language specific to `error.created` volume was found on any
`docs.sentry.io` page searched; general API rate limits (§5) are a separate, documented mechanism
and do not mention webhook delivery.

---

## 2. Issue-alert webhook action vs Internal Integration subscription

**Not two separate delivery mechanisms — one Integration Platform webhook pipe carries both**,
distinguished only by which resource you subscribed to. Per
[Integration Platform § Alerts](https://docs.sentry.io/integrations/integration-platform.md#alerts):
"You can make any integration available as an action in alerts by enabling the 'Alert Action'
toggle... For your service to receive webhooks for alerts, you must have `Send a notification via
<your integration>` as an action. Once that's set up, you'll start receiving webhook requests for
triggered alerts." There is no separate "paste a raw webhook URL into an alert rule" action
documented outside of selecting an installed integration.

### Per-individual-error vs per-alert-match vs per-lifecycle-transition

- **`error` resource** (`Sentry-Hook-Resource: error`): fires **per individual error event** as it
  is created — "only option currently is `created`" — Business/Enterprise only (§1). [errors.md](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/)
- **`event_alert` resource** ("Issue Alerts", the alert-rule action): action "will always be
  `triggered`" — fires **per matched alert-rule condition**, which itself can be configured to
  fire on thresholds, not necessarily 1:1 with error volume. "Sentry integrations which have been
  made available as alert actions can receive issue alert webhooks." [issue-alerts.md](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
- **`issue` resource**: fires **per issue lifecycle transition** — action ∈ `created`, `resolved`,
  `assigned`, `archived`, `unresolved` — not per raw error occurrence, and only for issues in the
  `OUTAGE`, `ERROR`, or `FEEDBACK` categories (§1). [issues.md](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)

### Identifiers/fields carried

Both `error` and `event_alert` payloads carry the full event — but **under different parent keys**:
`error` nests it at `data.error.*`, while `event_alert` nests it at `data.event.*` (verified field
paths: `data['event']['issue_id']`, `data['event']['event_id']`, `data['event']['culprit']`,
`data['event']['exception']['values'][0]['stacktrace']['frames']` —
[issue-alerts.md](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)).
In both cases the fields present are: `event_id`, `culprit`,
`exception.values[].stacktrace.frames[]` (file, line, function, and `pre_context`/`context_line`/
`post_context` source lines), `issue_id`, `issue_url` (API), `web_url`, `project` (numeric id only
— **no organization slug field is present in the payload body**; org identity must be resolved
server-side from `installation.uuid`). `event_alert` additionally carries `data.triggered_rule`
(the rule's label) and, for alert-action UI components, `data.issue_alert.title`/`.settings` (the
user's own routing configuration for that alert action — see [Alert Action](https://docs.sentry.io/integrations/integration-platform/ui-components/alert-action/)).
Source: [errors.md](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/),
[issue-alerts.md](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/).
**Suspect-commit data is not present in any of these payloads** — see §5 for the (undocumented)
suspect-commit endpoint.

### Stable delivery ID — **there is none. `Request-ID` must NOT be used as an idempotency key.**

A candidate header exists but is disqualified by Sentry's own implementation. Per
[webhooks.md](https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md),
every webhook request carries `"Request-ID": "<request_uuid>"`, documented only as "a unique
identifier for tracking and debugging specific events." Sentry never calls it a delivery ID the way
GitHub documents `X-GitHub-Delivery`, and the source explains why that omission matters:

1. **It is a fresh random UUID per send, not a function of the event.** `Request-ID` is
   `uuid4().hex` (§1) — nothing about the issue or event feeds it.
2. **It is regenerated on every retry.** The `AppPlatformEvent` object that owns the
   `@cached_property` is constructed _inside_ the body of each retried Celery task —
   `send_alert_webhook_v2` builds its `AppPlatformEvent` at the point of send, and
   `send_resource_change_webhook` does the same, each under a `retry=Retry(times=3, delay=60 * 5)`
   decorator. Because the task body re-runs from the top on retry, the `cached_property` cache dies
   with the old object and a **new `uuid4().hex` and a new `Sentry-Hook-Timestamp` are minted for
   each of the 3 retry attempts**. Sources:
   [sentry_apps.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/tasks/sentry_apps.py),
   [app_platform_event.py](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py).

**Consequence:** using `Request-ID` in a `webhook_events` unique constraint would dedup _nothing_.
The only scenario dedup exists to defend against — the same logical event arriving more than once
because Sentry retried — is precisely the scenario in which `Request-ID` differs. It is a
per-attempt trace id, the opposite of an idempotency key.

Also checked and rejected: `installation.uuid` is the **integration installation's** id, constant
across every delivery to that install; `Sentry-Hook-Timestamp` is send-time Unix seconds, so it too
varies per attempt. A targeted search of `docs.sentry.io` for "delivery id"/"webhook id" and a read
of the `event_alert`/`issue`/`error`/`comment` resource pages surfaced no stable per-delivery
identifier. **Conclusion: Sentry has no `X-GitHub-Delivery` equivalent.**

**Proposed synthetic dedup key** (own reasoning, not a Sentry claim) — key on _payload identity_,
which is invariant across retries, rather than on any header:

| Resource      | Proposed key                                  | Why it is stable                                                                                                       |
| ------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `error`       | `data.error.event_id`                         | Sentry event ids are unique per event; identical across all retries of that event                                      |
| `event_alert` | `data.event.event_id` + `data.triggered_rule` | Same event can legitimately match two different rules; the rule label disambiguates without collapsing distinct alerts |
| `issue`       | `data.issue.id` + `action`                    | No event id in lifecycle payloads; the (issue, transition) pair is the logical unit                                    |
| `comment`     | `data.comment_id` + `action`                  | `comment_id` is stable; `action` separates create/update/delete                                                        |
| `seer`        | `data.run_id` + `action`                      | `run_id` identifies the Autofix run; `action` separates the 7 lifecycle events (§3)                                    |

Note the differing nesting between resources — `event_alert` nests the event one level deeper
(`data.event.event_id`, `data.event.issue_id`, `data.event.culprit`) than `error` does
(`data.error.event_id`), verified directly against
[issue-alerts.md](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
and [errors.md](https://docs.sentry.io/integrations/integration-platform/webhooks/errors/). A single
generic extractor over `data` will silently miss one of the two.

---

## 3. Sentry Seer / AI autofix

### What it does today

"Seer is Sentry's AI debugging agent. It uses Sentry's rich context (issue details, tracing data,
logs, and profiles) to help you troubleshoot and fix errors and performance issues faster." —
[Seer](https://docs.sentry.io/product/ai-in-sentry/seer/). Autofix specifically: "a collaborative
workflow to find the root cause of, and solution to, issues... Autofix can propose a solution, or
be configured to follow through and open a PR with the solution." — [Autofix](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/).
The flow is three steps: **Root Cause Analysis → Solution Identification → Code Generation**
(same page).

### Does it open real PRs?

Yes. "You can prompt Seer to generate PRs, or merge requests on GitLab, to fix your issue and push
the changes to your repository... You must install the Seer Github or GitLab app to use this
feature." — [Seer](https://docs.sentry.io/product/ai-in-sentry/seer/). Setup requires connecting
GitHub/GitLab, connecting repos in "Seer SCM Settings," and connecting projects to repos in "Seer
Project Settings" — [Autofix § Getting Started](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/).
Constraint: "Seer supports GitHub.com and GitLab.com (cloud versions only). Self-hosted instances
and other SCM providers (Bitbucket, Azure DevOps) are not currently supported." (same page).
Organizations can disable it: "You can prevent Seer from creating PRs for your organization by
disabling code generation" (same page).

### Trigger mechanisms

- **Manual**: "You can always manually trigger the Autofix flow from the Issue Details page."
- **Automatic**: "When automation is enabled in your project's Seer settings, Sentry can also
  trigger Autofix automatically on issues that meet the following criteria: 1. The issue has 10 or
  more events... 2. The issue occurred within the last 14 days... 3. The issue has a sufficient
  fixability score." How far it goes automatically is capped by an org-chosen ceiling: **Stop
  after Root Cause / Stop after Plan / Stop after PR Drafted.** — [Autofix](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/).
- **Slack**: "Fix with Seer" button on new-issue Slack notifications — explicitly beta: "This
  feature is available to organizations enrolled in the **Early Adopter** program." (same page).
- **API**: not documented as a public trigger surface — checked `docs.sentry.io/api/` (no Seer/
  Autofix resource listed) and web search for a Seer REST endpoint; only an internal, undocumented
  signed RPC between Sentry and the Seer service was found, not part of the public API.

### Pricing/quota

"Seer is an add-on to your Sentry subscription. By enabling it, you are signing up for active
contributor pricing... Any person who creates 2 or more PRs/MRs in a month in a Seer-Enabled
repo/project will be billed." — [Seer](https://docs.sentry.io/product/ai-in-sentry/seer/). Current
rate: **$40 per active contributor per month**, billed separately, does not draw from PAYG budget
— [pricing.md#seer-pricing](https://docs.sentry.io/pricing.md#seer-pricing),
[manage-seer-budget](https://docs.sentry.io/pricing/quotas/manage-seer-budget/). "Seer is only
available when added to an existing **Team or Business** plan" (same page) — it is not gated to
Business/Enterprise the way `error.created` webhooks are. Legacy pricing (closed to new
subscribers): "As of January 2026, Legacy Seer pricing will no longer be offered as an add-on...
if you were subscribed to Seer before January 2026 you are likely on legacy Seer pricing, which is
$20/month per Sentry subscription, plus $25 worth of Seer event credits" ($1/fix run, $0.003/issue
scan) — [pricing.md#legacy-seer-pricing](https://docs.sentry.io/pricing.md#legacy-seer-pricing).

### Output consumable via webhook/API?

**Via webhook: yes, documented, down to the field level.** A dedicated `seer` resource exists:
"Sentry integrations that have subscribed to Seer webhooks can receive notifications about the
Seer Autofix process... support seven different event types": `seer.root_cause_started`,
`seer.root_cause_completed`, `seer.solution_started`, `seer.solution_completed`,
`seer.coding_started`, `seer.coding_completed`, and **`seer.pr_created`** — "Triggered when pull
request(s) are created." Common payload fields on every event: `data.run_id` (the analysis run)
and `data.group_id` (the Sentry issue id). The `pr_created` payload specifically ("there may be
more than one pull request if there are multiple repos"): `data.pull_requests[]`, each with
`pull_request.pr_number`, `pull_request.pr_url` (e.g. `"https://github.com/owner/repo/pull/123"`),
`pull_request.pr_id`, `repo_name`, and `provider`. Source: [Seer webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/seer/).
**Via REST API: not documented** (see Trigger mechanisms above).

### External coding-agent handoff

"Seer always performs root cause analysis and solution planning using its own internal tools and
Sentry context. At the final code generation step, instead of having Seer generate the code fix
directly, you can hand off to an external coding agent for implementation... **Coding agent handoff
only works with GitHub.** Supported coding agents for handoff: Claude Agent, Cursor Cloud Agent,
GitHub Copilot Cloud Agent." — [Autofix § Handoff to Coding Agents](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/#handoff-to-coding-agents).

### The central build-vs-buy question

**For a GitHub/GitLab.com repo on a Team or Business plan, Seer's built-in automation already is
the "Sentry error → PR" loop end-to-end**, documented and GA: automatic trigger on qualifying
issues → root cause → solution → code generation → PR opened, with a `seer.pr_created` webhook
(carrying the PR URL) to observe completion. A custom build duplicates this unless one of these
documented gaps matters:

1. **SCM scope** — GitHub.com/GitLab.com cloud only; no self-hosted Sentry, no Bitbucket/Azure
   DevOps ("not currently supported," [autofix.md](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/)).
2. **Coding-agent choice** — handoff is hard-coded to exactly three integrations (Claude Agent,
   Cursor Cloud Agent, GitHub Copilot Cloud Agent); no generic "call any external agent" hook other
   than reacting to `seer.*` webhooks yourself.
3. **No trigger API** — automation is limited to Sentry's own fixed criteria (10+ events, <14
   days, ML fixability score) or a human clicking a UI button/Slack action; there is no
   programmatic "run Autofix on issue X now" call to layer custom logic on top of.
4. **Automation gating is Sentry's ML model, not yours** — the fixability-score threshold and the
   "how far to automate" ceiling are Sentry's own knobs, not independently controllable per-rule
   logic.
5. **Cost model** — a flat $40/active-contributor/month add-on, not a pay-per-issue or
   bring-your-own-model cost structure.

---

## 4. Sentry's official MCP server

### Existence and hosting

Yes — `getsentry/sentry-mcp` on GitHub: "Sentry's MCP service is primarily designed for
human-in-the-loop coding agents... This remote MCP server acts as middleware to the upstream
Sentry API, optimized for coding assistants like Cursor, Claude Code, and similar development
tools." Hosted at **`https://mcp.sentry.dev`** ("You'll find everything you need to know by
visiting the deployed service in production: https://mcp.sentry.dev"). Source: [README](https://github.com/getsentry/sentry-mcp).
`docs.sentry.io/product/sentry-mcp/` resolves to the same `mcp.sentry.dev` application (its
`og:url` meta tag is `https://mcp.sentry.dev/`, title "Sentry MCP," description "A Model Context
Protocol implementation for interacting with Sentry."), confirming it as the documented product
surface.

### Transport

The remote server "is based on [Cloudflare's work towards remote MCPs]" — i.e. Streamable
HTTP/SSE, the Cloudflare remote-MCP pattern. A **stdio transport is also supported but explicitly
flagged as in-progress**: "we also support a `stdio` transport. This is still a work in progress,
but is the easiest way to adapt run the MCP against a self-hosted Sentry install." Source: [README](https://github.com/getsentry/sentry-mcp).

### Auth model

- **Remote (hosted)**: OAuth — "Your client connects over Streamable HTTP with OAuth — there's
  nothing to install. Sentry uses OAuth: the first time you connect, your MCP client opens a
  browser window to sign in and authorize access." Local-dev setup instructions describe creating
  an OAuth App in Sentry (Settings → API → Applications) with a Client ID/Secret and redirect URI.
- **Remote with an explicit token**: clients that support custom headers can instead pass
  `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}` — "`Sentry-Bearer` is intentionally
  separate from `Bearer`: `Bearer` is reserved for MCP OAuth access tokens. With `Sentry-Bearer`,
  the worker does not store, validate, exchange, or refresh the upstream token."
- **Stdio**: a Sentry **User Auth Token** with scopes `org:read`, `project:read`, `project:write`,
  `team:read`, `team:write`, `event:write` ("As of writing this is:" — listed scopes), run via
  `npx @sentry/mcp-server@latest --access-token=sentry-user-token`.
  Source: [README](https://github.com/getsentry/sentry-mcp).

### Tool surface

48 tools total, organized into 5 "skills" — per `packages/mcp-core/src/skillDefinitions.json` and
`toolDefinitions.json` in [getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp/blob/main/packages/mcp-core/src/skillDefinitions.json)
(fetched 2026-07-25):

| Skill                | Tools | Default | Description (verbatim)                                                                                                                                                       |
| -------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`            | 35    | on      | "Read-only access to core Sentry data: issues, events, traces, replays, releases, monitors, profiles, documentation, and project metadata"                                   |
| `seer`               | 11    | on      | "Sentry's AI debugger that helps you analyze, root cause, and fix issues" (includes `analyze_issue_with_seer`, `get_issue_details`, `get_event_stacktrace`, `search_issues`) |
| `docs`               | 5     | **off** | "Deprecated legacy docs-only grant. Documentation tools are now available through Inspect Issues & Events."                                                                  |
| `triage`             | 17    | off     | "Resolve, assign, and update issues"                                                                                                                                         |
| `project-management` | 12    | off     | "Create and modify projects, teams, and DSNs"                                                                                                                                |

Individual tool names include `get_issue_details`, `get_event_stacktrace`, `get_issue_activity`,
`search_issues`, `search_events`, `analyze_issue_with_seer`, `update_issue`, `add_issue_note`,
`find_alert_rules`, `create_project`, `whoami`, and 37 others. Tool selection is deliberately
narrow: "Our tool selection and priorities are focused on developer workflows and debugging use
cases, rather than providing a general-purpose MCP server for all Sentry functionality." —
[README](https://github.com/getsentry/sentry-mcp).

### Self-hostable vs Sentry-hosted only

**Both.** The default path is Sentry-hosted (`https://mcp.sentry.dev`), but the server is
source-available and can be run against a self-hosted Sentry install: `npx
@sentry/mcp-server@latest --access-token=TOKEN --host=sentry.example.com
[--insecure-http]`, with the note "Some features (like Seer) may not be available on self-hosted
instances. You can disable specific skills... `--disable-skills=seer`." License, per `LICENSE.md`
in the repo: **FSL-1.1-Apache-2.0** ("Functional Source License, Version 1.1, Apache 2.0 Future
License" — the same license family Sentry's core product uses). Source: [README](https://github.com/getsentry/sentry-mcp),
[LICENSE.md](https://github.com/getsentry/sentry-mcp/blob/main/LICENSE.md).

### Beta/early-access language

No beta/GA-caveat language was found for the hosted server as a whole. The **stdio transport is
explicitly called "still a work in progress"** in the README, with no date attached.

---

## 5. Sentry REST API for issue detail

### The issue itself

`GET /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/` — "Return details on an
individual issue, including its basic stats, comment and user-report counts, and a summary of the
latest event." Requires bearer auth with scope `event:admin`, `event:read`, or `event:write`.
Source: [Retrieve an Issue](https://docs.sentry.io/api/events/retrieve-an-issue/).

### Latest event with stack trace + source context

`GET /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/events/{event_id}/` where
`event_id` accepts a literal id or one of `latest`, `oldest`, `recommended` — "Retrieves the
details of an issue event." Same scopes (`event:admin`/`event:read`/`event:write`). The
documented example response includes `entries[].data.values[].stacktrace.frames[].context` — an
array of `[lineNo, sourceLine]` tuples — **in the default response**, i.e. surrounding source
lines are included without any extra query parameter. Source: [Retrieve an Issue Event](https://docs.sentry.io/api/events/retrieve-an-issue-event/).

### Suspect commits

**No public, documented endpoint.** Sentry's own product documentation for the feature describes
the algorithm but names no API: "Sentry will look at the stack trace of an issue and collect all
in-app frames. For each in-app frame, Sentry checks the blame info for the exact file and line
number. If the most recent commit is less than 1 year old, we consider it a suspect commit," and
results are surfaced only via the product UI — "Suspect commits and suggested assignees are then
displayed on the **Issue Details** page in sentry.io." The feature is also scoped to error issues
only: "This feature is only applicable for error issues. Other categories of issues (such as
performance issues or replay issues) do not support this feature." Source: [Suspect Commits](https://docs.sentry.io/product/issues/suspect-commits/).

The underlying implementation exists in source — `EventFileCommittersEndpoint(ProjectEndpoint)` in
`src/sentry/api/endpoints/event_file_committers.py` — decorated with `publish_status = {"GET":
ApiPublishStatus.PRIVATE}`. Source: [event_file_committers.py](https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/event_file_committers.py).
A Sentry engineer confirmed this directly in a public issue: "We have an API that returns
committers here... It is marked private though which is why we don't have public documentations
about it. Sending to issues team, the owner of the API, so see if this should actually be
documented." A product-side reply the same week said "I think we can make this public, adding it
to the epic for API publishing," and a follow-up clarified the risk of using it anyway: "That's
correct - an API marked private is one which may end up with breaking changes down the line since
we aren't expecting customers to rely on it." As of 2026-07-25 it remains **undocumented** on
`docs.sentry.io` (checked the "Events & Issues" API index — no committers/suspect-commit page
listed). Source: [getsentry/sentry#80771](https://github.com/getsentry/sentry/issues/80771).

### Tags

`GET /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/tags/{key}/` (tag detail) and
`GET /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/tags/{key}/values/` (tag
values) — both documented as returning "at most 1000 values" when paginated. Sources:
[Retrieve Tag Details](https://docs.sentry.io/api/events/retrieve-tag-details/),
[List a Tag's Values for an Issue](https://docs.sentry.io/api/events/list-a-tags-values-for-an-issue/).

### Auth model

`docs.sentry.io` documents **three key types of auth tokens**, each mapped to the same
[Permissions & Scopes](https://docs.sentry.io/api/permissions.md):

- **Organization Tokens** — "bound to an organization, and have access to all projects within
  that organization. They have a limited set of permissions and are designed to be used in CI
  environments and with Sentry CLI." Created at **Settings > Developer Settings > Organization
  Tokens**; permissions "aren't customizable... set to allow most CI-related tasks." "For most
  scenarios, we recommend using Organization Tokens" — [Auth Tokens](https://docs.sentry.io/account/auth-tokens.md).
- **Internal Integration tokens** — "bound to an organization... can be created with a custom set
  of permissions, and are designed to be used in cases where organization tokens don't have
  sufficient access rights... should be used when you need full API access." "Internal
  integrations automatically generate tokens after installation." Sources: [Auth Tokens](https://docs.sentry.io/account/auth-tokens.md),
  [Integration Platform](https://docs.sentry.io/integrations/integration-platform.md#auth-tokens).
- **Personal (User) Tokens** — "bound to a user, and have access to all organizations and projects
  that user has access to," created at **User settings > Personal Tokens**, scopes chosen at
  creation and not editable later. Required for user-specific endpoints (e.g. Retrieve an
  Organization). Source: [API Authentication](https://docs.sentry.io/api/auth/).
- **OAuth2** (authorization code + PKCE, plus a **Device Authorization Flow**, RFC 8628, for
  headless/CLI use) "for third-party applications that need to access Sentry on behalf of users."
- **Legacy API Keys** (HTTP Basic) also exist — "will still be supported but are disabled for new
  accounts." Source: [API Authentication](https://docs.sentry.io/api/auth/).

Scopes (from [Permissions & Scopes](https://docs.sentry.io/api/permissions/)): Issues & Events —
`event:read` (GET), `event:write` (PUT), `event:admin` (DELETE); Organizations — `org:read` /
`org:write` / `org:admin`. The issue/event endpoints above accept any of `event:read`,
`event:write`, `event:admin` per their own scope lists.

### Rate limits

"Sentry rate limits every API request made to prevent abuse and resource overuse. The limit is
applied to each unique combination of caller and endpoint... a fixed window approach... Each
endpoint has its own maximum number of requests and window size," plus a separate concurrent-
request limiter. No universal numeric limit is published; instead every response carries live
headers: `X-Sentry-Rate-Limit-Limit`, `X-Sentry-Rate-Limit-Remaining`, `X-Sentry-Rate-Limit-Reset`,
`X-Sentry-Rate-Limit-ConcurrentLimit`, `X-Sentry-Rate-Limit-ConcurrentRemaining`. Sentry's own
guidance: "Polling the API for updates is likely to quickly trigger rate limiting. We recommend
using our webhooks, if possible." Source: [Rate Limits](https://docs.sentry.io/api/ratelimits/).

---

## What this means for Alfred

- **The existing `webhook_events` design does not transfer to Sentry.** It dedups on a provider
  delivery UUID, and Sentry has no such value: `Request-ID` is `uuid4().hex` re-minted on each of
  the 3 retry attempts (§2), so storing it would admit every retry as a fresh row and defeat the
  constraint in exactly the case it exists for. The Sentry ingress needs a **provider-specific
  synthetic key column** (`data.error.event_id` / `data.event.event_id` / `issue.id`+`action`) rather
  than reusing the GitHub-shaped delivery-UUID column — a schema decision, not just a mapping detail.
- **Write the payload extractor per-resource, not generically.** `error` puts the event at
  `data.error.*` and `event_alert` puts it at `data.event.*` (§2); a single `getPath(data, "event",
…)` helper silently yields `undefined` for half the traffic, which — combined with the point above
  — would produce null dedup keys and thus unbounded duplicate processing rather than a loud failure.
- Because Sentry's own retry policy only fires on network failures/timeouts and explicitly ignores
  a 4xx (`ClientError` is in the ignore list, per `sentry_apps.py`), the Elysia ingress must
  **always return 2xx within ~1 second** even for payloads it will reject internally — a 4xx for
  "bad/duplicate payload" will silently not be redelivered, so any real error handling has to
  happen after the fast ack, not by relying on Sentry to retry a non-2xx. The 1000-timeouts/24h
  auto-unsubscribe rule means sustained downtime for even a few hours risks Sentry silently
  dropping the integration's webhook subscription entirely.
- `error.created` (per-individual-error webhooks) requires **Business/Enterprise** ($89/mo+); if
  the target org is Free/Team, the only usable per-issue trigger is the `event_alert` resource
  reached through an Alert Rule's "Send a notification via `<integration>`" action — meaning Alfred
  needs at least one configured Alert Rule per project, not just an installed integration. The
  `issue` resource is a further fallback but only fires on lifecycle transitions in the `OUTAGE`,
  `ERROR`, `FEEDBACK` categories, not on every raw error.
- **Signature verification must read raw bytes, and the signature covers the body only.** Sentry
  HMACs the exact string it transmits — Python `json.dumps` output (§1) — so re-serializing an
  already-parsed JS object is not equivalent: Python's default separators and key order need not
  match `JSON.stringify`, and any divergence rejects a legitimate delivery, meaning the Sentry route
  must opt out of automatic JSON body parsing rather than copy the docs' JS sample. Note also that
  `Sentry-Hook-Timestamp` is **not** part of the signed bytes, so unlike Stripe there is no
  signed-timestamp replay window to enforce — and since the timestamp is regenerated per retry, a
  "reject old timestamps" rule would drop legitimate 10-minute-late retries while stopping no replay.
- **Seer is the buy-side answer, so the build must be justified against it, not against nothing.**
  Autofix is GA and already runs automatic-trigger → root cause → solution → real PR with a
  `seer.pr_created` webhook (§3). A custom loop is only defensible where Seer's documented limits
  bind: a coding agent other than the three supported handoffs (Claude Agent, Cursor Cloud Agent,
  GitHub Copilot Cloud Agent), a non-GitHub/GitLab.com SCM, or programmatic control over _when_ the
  work runs. Alfred's actual differentiator is that third gap — Seer offers no trigger API and gates
  automation behind its own fixability score, so "Alfred decides which errors are worth fixing" is
  the only part of this loop that cannot be bought.
- Suspect-commit data has **no public API** (the real endpoint is `ApiPublishStatus.PRIVATE`), so
  a custom loop cannot pull "which commit likely caused this" from Sentry directly — it would need
  to derive that itself from the stack trace's file paths against the GitHub App's own commit
  history, or accept the private/undocumented-and-breakable endpoint at its own risk.
- Sentry's own docs recommend webhooks over polling for exactly this class of integration ("We
  recommend using our webhooks, if possible" — [Rate Limits](https://docs.sentry.io/api/ratelimits/)) —
  the REST issue/event endpoints (§5) should be used only for one-shot enrichment right after a
  webhook fires, never for periodic state polling. For that enrichment call, an **Organization
  Token** (fixed CI-oriented scopes, revocable, no user tied to it) is the better fit for a
  long-running server integration than a Personal Token tied to one human's account.

---

## Sources

- Webhooks (headers, envelope, signature, timeout, event types): `https://docs.sentry.io/organization/integrations/integration-platform/webhooks.md`
- Errors resource (plan gating): `https://docs.sentry.io/integrations/integration-platform/webhooks/errors/`
- Issues resource (category restriction): `https://docs.sentry.io/integrations/integration-platform/webhooks/issues/`
- Issue Alerts resource: `https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/`
- Comments resource: `https://docs.sentry.io/integrations/integration-platform/webhooks/comments/`
- Alert Action UI component (settings paths per alert type): `https://docs.sentry.io/integrations/integration-platform/ui-components/alert-action/`
- Seer webhook resource: `https://docs.sentry.io/integrations/integration-platform/webhooks/seer/`
- Integration Platform overview (creation path, alert-action wiring, auth tokens): `https://docs.sentry.io/integrations/integration-platform.md`
- Webhook auto-unsubscribe changelog (2023-10-03): `https://sentry.io/changelog/2023-10-3-change-to-integration-platform-webhook-handling/`
- Seer product overview: `https://docs.sentry.io/product/ai-in-sentry/seer/`
- Autofix: `https://docs.sentry.io/product/ai-in-sentry/seer/autofix/`
- Pricing (Seer pricing, legacy Seer pricing, plan tiers): `https://docs.sentry.io/pricing.md`
- Manage Seer spend: `https://docs.sentry.io/pricing/quotas/manage-seer-budget/`
- sentry.io pricing page (Team/Business monthly/annual prices, structured data): `https://sentry.io/pricing/`
- Auth Tokens overview (Organization/Internal Integration/Personal): `https://docs.sentry.io/account/auth-tokens.md`
- API Authentication (OAuth2, device flow, personal tokens, API keys): `https://docs.sentry.io/api/auth/`
- API Permissions & Scopes: `https://docs.sentry.io/api/permissions/`
- API Rate Limits: `https://docs.sentry.io/api/ratelimits/`
- Retrieve an Issue: `https://docs.sentry.io/api/events/retrieve-an-issue/`
- Retrieve an Issue Event: `https://docs.sentry.io/api/events/retrieve-an-issue-event/`
- Retrieve Tag Details: `https://docs.sentry.io/api/events/retrieve-tag-details/`
- List a Tag's Values for an Issue: `https://docs.sentry.io/api/events/list-a-tags-values-for-an-issue/`
- Events & Issues API index: `https://docs.sentry.io/api/events.md`
- Suspect Commits product doc: `https://docs.sentry.io/product/issues/suspect-commits/`
- `getsentry/sentry-mcp` README: `https://github.com/getsentry/sentry-mcp`
- `getsentry/sentry-mcp` LICENSE.md: `https://github.com/getsentry/sentry-mcp/blob/main/LICENSE.md`
- `getsentry/sentry-mcp` tool/skill definitions: `https://github.com/getsentry/sentry-mcp/blob/main/packages/mcp-core/src/skillDefinitions.json`, `.../toolDefinitions.json`
- `getsentry/sentry` webhook retry/circuit-breaker source: `https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/tasks/sentry_apps.py`, `https://github.com/getsentry/sentry/blob/master/src/sentry/utils/sentry_apps/webhooks.py`
- `getsentry/sentry` webhook header construction (`Request-ID` = `uuid4().hex`, `Sentry-Hook-Timestamp`, payload envelope, custom `webhook_headers`): `https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py`
- `getsentry/sentry` custom-header parsing/masking: `https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/utils/headers.py`
- `getsentry/sentry` `build_signature` (HMAC-SHA256 over body bytes with `client_secret`): `https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/models/sentry_app.py`
- `getsentry/sentry` suspect-commit endpoint (private): `https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/event_file_committers.py`
- `getsentry/sentry` issue confirming suspect-commit API is private: `https://github.com/getsentry/sentry/issues/80771`
