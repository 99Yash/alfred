# ADR-0100 — An inbound delivery alert is a banner and one email, never a briefing line

**Status.** Accepted (issue #1035, PR #1038). Motivated by incident #1033. Refines ADR-0097 item 5. Amends nothing in ADR-0048.

**Decision.** An inbound source that stopped delivery reaches the user through two surfaces: a live app banner, and at most one pushed `health_alert` email per source per week. It never reaches the user through the morning or evening briefing. A delivery verdict names a cause, and only the cause `broken` is alertable. A verdict whose recovery is `retry` or `none` is operator text and stays in the log.

Four sub-decisions follow.

1. **A verdict carries a cause, because two readers want opposite answers.** `EventDeliveryHealth` already told a reader that a source will not deliver. It did not tell the reader why. Workflow readiness must refuse every trigger it cannot arm, so it wants the widest answer. An alert surface must speak only when the user lost something, so it wants the narrowest answer. The unhealthy arm now carries `cause: "never_connected" | "broken" | "unknown"` (`connections/ingress/descriptor.ts`). Each reader filters on the value. Before this, the alert reader had to re-derive the no-adapter case from the registry, which put two folds over one registry on opposite sides of the same question.
2. **One rule decides what a person sees.** `connections/delivery-alerts.ts` holds it, and both surfaces call it. A verdict is alertable only when the cause is `broken` **and** the recovery is `{ kind: "connect", integration }` for a live integration. The two conditions are different questions. The cause says that the user lost something. The recovery says that the user can get it back. A `retry` or `none` recovery describes delivery that time or an operator restores, which ADR-0097 item 5 already classes as `trigger_degraded`. Such a reason is written for an operator: it names environment variables and deployment facts. One rule in one module is what keeps the banner and the email from disagreement.
3. **Two surfaces, both of which already exist.** The banner rides `readIntegrationStatus`, the read that builds every integration tile and that the web polls. It is live, so it is never stale, and it sits beside the button that repairs it. The email rides the `ingress.health_sweep` repeatable job and the sanctioned `notify({ kind: "health_alert" })` channel. The banner waits for the user to open Alfred. The sweep is the half that does not wait.
4. **A pull check is the only check.** A source that produces deliveries only while it is healthy cannot report its own silence. It sends nothing when it breaks, so no push signal exists. Alfred must ask. Nothing asked before this change.

---

## Why not the briefing

The first attempt put a degraded-source line in the morning briefing. Three facts rejected it.

- The briefing suppresses a quiet morning. A broken subscription is one of the causes of a quiet morning. The surface would go silent for exactly the reason it exists.
- A briefing line is prose in a daily narrative. A broken subscription needs a repair and a button. The two do not belong on one surface.
- The briefing reads the data that the broken source feeds. A report of its own blindness inside that report asks the user to trust the rest of the page.

ADR-0048 stays as written. `isQuietMorning`, `briefingGatherSchema` and the compose step are untouched.

## The cause vocabulary

| Cause | What it means | Readiness | Alert |
| --- | --- | --- | --- |
| `never_connected` | The user never connected this source. Nothing broke. | refuses the trigger | silent |
| `broken` | The user connected this source and delivery stopped. | refuses the trigger | speaks |
| `unknown` | Alfred holds no health signal, so the silence proves nothing. | refuses the trigger | silent |

`unknown` is the sentinel for a descriptor with no `subscription` adapter. It makes ADR-0097 item 5's rule readable from the value.

The cause is independent of the recovery. GitHub shows why. A user with no GitHub credential row and a user whose App installation is gone both get the recovery `{ kind: "connect", integration: "github" }`, because one button repairs both. Only the second user lost something. `hasAnyCredential` in `packages/integrations/src/shared/credentials.ts` separates them: any row at all, at any status, proves that the user set this up once.

The same rule reordered the Sentry check. The secret check ran first and answered `SENTRY_WEBHOOK_CLIENT_SECRET is not set` to every user of every deployment that never registered Sentry. The credential check now runs first, so a user with no Sentry reads `no Sentry organization is connected`. Both orders give the same healthy or unhealthy verdict. They differ only in which reason wins when both are wrong, and the connected question is the one the user can answer.

## What the user sees

**The banner.** `DeliveryAlertBanner` sits in the app shell beside `ScopeGapBanner` and `GithubReconnectBanner`. It reads "Alfred stopped receiving GitHub activity", then the verdict's own sentence, then a button to that integration's page. It names no provider in its code: the display name and the route both come from the slug the verdict carried, so a new inbound source reaches the banner with no edit. It shows one card at a time, and the next card appears after the user resolves or dismisses the first.

**The email.** One `health_alert` send per broken source, with the key `health_alert:{userId}:inbound_delivery.{source}:{local-day}`. The subject states the loss and the body carries the same sentence and the same link. The template `packages/mailer/src/emails/delivery-alert.tsx` follows the `workflow-blocked` pair.

## The wire carries slugs, not copy

`deliveryAlerts` on `integrationStatusSchema` carries an integration slug and one sentence. It carries no display name and no URL. The web owns both already, so it resolves both at render time; a transmitted label would freeze today's wording into tomorrow's page. The event source slug does not go on the wire either. It keys the email's repeat window server-side, and ADR-0097 item 5 states that the source space and the integration space are different spaces. One sentence must not hold two slug spaces.

The field carries `.default([])`. A browser on a new bundle against a server that has not restarted reads an absent key as an empty list. Without the default, that browser fails the parse and reports every integration as disconnected.

The list holds at most one entry per integration. One integration is one repair, so two broken sources behind it would ask the user to press one button twice. Registry order picks the winner, so the choice is stable across reads.

The web drops an alert for an integration that an active credential row already fails the connected rule for. `useGithubReconnect` and `useGoogleScopeGaps` nag about that same integration and offer that same repair. Two cards for one click read as two problems.

## The sweep

`ingress.health_sweep` runs every 6 hours on the ingestion queue. The interval is not the rate limit. The email is limited to one per source per week, so the interval only bounds how long a break stays unreported, and a single failed run still has three more before the day ends.

The 7-day window is a read over `email_sends` for `kind = 'health_alert'` and `status = 'sent'`, covered by `email_sends_user_kind_idx`. `sent` only: a queued or failed row means that the user was told nothing, so the source still owes them an alert. The window read is a bounded select plus a `startsWith` in JavaScript. `LIKE` is unsafe here, because `health_alert` contains `_`, which is a `LIKE` wildcard.

A day would nag about a state that the banner already shows. A week is long enough to stay news, and short enough that a break in the background gets raised again.

The sweep lives in `connections/ingestion/`, not beside the health reader. It reaches `@alfred/assistant/delivery` and `@alfred/mailer`. The ingress door stays light enough for workflow readiness to import.

## Alternatives

- **A briefing line.** Rejected. See **Why not the briefing** above.
- **A second reader that re-derives the cause from the registry.** Rejected. Two folds over one registry answered the no-adapter case oppositely, and only a comment held them together. A discriminator on the value costs one field and cannot drift.
- **One surface only.** Rejected. A banner alone waits for the user to open the app, and #1033 ran for weeks. An email alone is stale by the time the user reads it, and it cannot state that the break is over.
- **A dedicated `delivery_alerts` table.** Rejected. `email_sends` already records what was sent, to whom, and when. A second table would hold the same facts and could disagree with the first.
- **A `deliveryAlerts` payload with display copy and a URL.** Rejected. The web owns both, and a stored label ages.
- **An hourly sweep.** Rejected. The banner already carries the live truth. An hourly pull adds database reads and moves no alert forward, because the email rate limit is a week.

## Preserved behavior

Workflow readiness is unchanged. `trigger_degraded` and `trigger_not_ready` still follow the recovery kind, as ADR-0097 item 5 states. Every existing producer returns the same healthy or unhealthy verdict it returned before, with one field added. The briefing is byte-identical to `main`. The `health_alert` drift alerts keep their key shape and their behavior.

## Residual risk

The GitHub descriptor still cannot detect the exact signature of #1033. `hasActiveInstallationCredential` proves only that some `installation_id` is non-null on an active row. In #1033 an active row held an installation id that no longer matched the App's installation, so this check reads `healthy: true` and no alert fires. A correct check needs a GitHub API call, which does not belong in a read that the web polls every 30 seconds. This ADR delivers the schedule and the surfaces. The descriptor fix is separate work.

Recovery is not observed. A source that breaks, is repaired, and breaks again inside 7 days is emailed one time. The banner carries the second break live, so the silence is still broken.

No feature tests. The compiler carries the cause on every producer, because the unhealthy arm requires the field. The `zod` parse at the status boundary carries the wire shape. The surface rule is one pure function over the verdict, and nothing else reads the verdict for a user surface.
