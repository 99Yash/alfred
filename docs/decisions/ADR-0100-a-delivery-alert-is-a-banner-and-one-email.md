# ADR-0100 — A delivery alert is a banner and one email, never a briefing line

**Status.** Accepted (issue #1035, PR #1038). Motivated by incident #1033. Refines ADR-0097 item 5. Amends nothing in ADR-0048.

**Decision.** An event source that stopped delivering reaches the user through two surfaces: a live app banner, and at most one pushed `delivery_alert` email per source per week. It never reaches the user through the morning or evening briefing. A delivery verdict names a cause. Only the cause `broken`, with a recovery the user can perform, and with no other surface already asking for the same click, is alertable. Every other verdict is operator text and stays in the log.

Five sub-decisions follow.

1. **A verdict carries a cause, because two readers want opposite answers.** `EventDeliveryHealth` already told a reader that a source will not deliver. It did not tell the reader why. Workflow readiness must refuse every trigger it cannot arm, so it wants the widest answer. An alert surface must speak only when the user lost something, so it wants the narrowest answer. The unhealthy verdict now carries `cause: "never_connected"`, `"broken"` or `"unknown"` (`connections/ingress/descriptor.ts`). Each reader filters on the value. Before this, the alert reader had to re-derive the no-adapter case from the registry, which put two folds over one registry on opposite sides of the same question.
2. **The cause pins the recovery, one arm per outcome.** `EventDeliveryFailure` is a union of three arms, not a record with two independent fields. A free cross product admits nine pairs and only five of them mean anything. `{ cause: "unknown", recovery: { kind: "connect" } }` claims that Alfred holds no signal and also knows the repair. `{ cause: "never_connected", recovery: { kind: "retry" } }` claims that time restores a subscription nobody made. `never_connected` therefore pins `connect`, `unknown` pins `none`, and only `broken` keeps all three recoveries, because it needs all three: the user reconnects a lapsed Gmail watch, time restores a delivery coverage gap, and an operator sets a missing signing secret. The compiler refuses the rest, so no paragraph has to.
3. **One rule decides what a person sees, and it folds every source.** `readDeliveryAlerts` in `connections/delivery-alerts.ts` holds it, and both surfaces call it. It folds `EVENT_SOURCES`, at both grains, not the inbound sources only. The first revision folded inbound sources only, which skipped Gmail — and Gmail's lapsed Pub/Sub watch is the one break this rule had already seen in production. A verdict is alertable on three conditions, and it must meet all three. The cause must be `broken`: the user lost something. The recovery must be `{ kind: "connect", integration }` for a live integration: the user can get it back, and a page exists to send them to. And no credential nag of the same integration may already be on screen: `nagsOwnCredential` decides that, server-side, so the banner and the email suppress the same states.
4. **Two surfaces, both of which already exist.** The banner rides `readIntegrationStatus`, the read that builds every integration tile. It is live, so it is never stale, and it sits beside the button that repairs it. The email rides a new `ingress.health_sweep` repeatable job and the sanctioned `send({ kind: "delivery_alert" })` channel. The banner waits for the user to open Alfred. The sweep is the half that does not wait.
5. **A pull check is the only check.** A source that produces deliveries only while it is healthy cannot report its own silence. It sends nothing when it breaks, so no push signal exists. Alfred must ask. Nothing asked before this change.

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
| `broken` | The user connected this source and delivery stopped. | refuses the trigger | speaks, if the user can repair it |
| `unknown` | Alfred holds no health signal, so the silence proves nothing. | refuses the trigger | silent |

`unknown` is the sentinel for a descriptor with no `subscription` adapter. It makes ADR-0097 item 5's rule readable from the value. No descriptor reaches it today, because `github` and `sentry` both declare an adapter. It is the verdict the next descriptor gets for free, and it is the reason a descriptor may leave `subscription` off at all.

## Which states can actually speak

A cause is not enough. The alert rule adds two more conditions, so the set of reachable alerts is small and worth naming.

- **A GitHub row that holds an installation id and is no longer active.** GitHub's adapter reads the connected rule (ADR-0093) first: an active row that carries an `installation_id` is healthy. When no row satisfies it, a non-null `installation_id` on **any** row, at any status, is the fact that separates the two unhealthy answers. That column is a durable record that the user once completed Install and Authorize, so App deliveries did flow and have stopped. A revoked or expired row that carries one is `broken`, and it is alertable.
- **A Gmail account whose watch lapsed.** `WATCH_NOT_INSTALLED` in `connections/ingestion/gmail-event-health.ts` is `broken` with recovery `connect gmail`. The verdict is only ever asked of a row that exists, so the user connected Gmail and the watch has since gone.

Two states look alertable and are not.

- **A GitHub row with no installation id.** A classic-OAuth row that predates the App migration (ADR-0052) never received one delivery, so "Alfred stopped receiving GitHub activity" would be false. It reads `never_connected`. `GithubReconnectBanner` already names that row and offers that repair. The first revision read "any row at all" here, which claimed a break that never happened, on the one state the deployment actually holds.
- **Every Sentry verdict.** Sentry's two `broken` arms are a missing `SENTRY_WEBHOOK_CLIENT_SECRET` and more than one connected organization. Both carry `recovery: { kind: "none" }`, because only an operator can act on either. The rule filters both out. Sentry cannot produce an alertable verdict today.

Sentry's check order is `main`'s order, unchanged. An earlier revision put the credential question before the environment question, to improve which reason an operator reads. That reorder was withdrawn. `deliveryProblem` in workflow readiness branches on the **recovery** kind, not on the cause, so the reorder would have turned a deployment with no Client Secret from `trigger_degraded`, where the run defers quietly, into `trigger_not_ready`, where the workflow blocks and the owner is emailed. It bought a better operator log line with an email nobody asked for, and it bought the alert surface nothing, because the rule filters both arms whichever one wins.

## Where the code lives

The health readers moved into `connections/`:

- `automation/event-source-health.ts` → `connections/event-source-health.ts`
- `automation/gmail-event-readiness.ts` → `connections/ingestion/gmail-event-health.ts`

They read credential rows and ingestion state, both of which `connections/` owns, so this is the better home on its own merits. It is also the only home available. `scripts/module-architecture-baseline.json` records no strongly connected component in the assistant module graph, and `automation -> connections` is an edge that graph already carries. A rule placed in `automation/` and called from the integration-status read would need `connections -> automation`, which `check:architecture` refuses as a cycle. A fold in `automation/` would therefore have forced the alert reader to cover a strict subset of the sources — and that subset is exactly how Gmail's lapsed watch went unread.

Both readers, and `InboundSubscriptionAdapter.health`, now take `CredentialRowsByProvider` instead of the whole availability snapshot. Every caller already holds the rows, so the verdicts cost no credential query of their own and cannot disagree with the tiles beside them about which rows exist.

The sweep lives in `connections/ingestion/`, beside the queue that runs it, not beside the alert rule. It reaches `@alfred/assistant/delivery` and `@alfred/mailer`. The alert rule's own door stays light enough for the integration-status read to import.

## What the user sees

**The banner.** `DeliveryAlertBanner` sits in the app shell beside `ScopeGapBanner` and `GithubReconnectBanner`. It reads "Alfred stopped receiving GitHub activity", then the verdict's own sentence, then a button. The button is a full-page redirect to `${API_URL}${integrationRoutePrefix(credentialProviderOf(slug))}/connect`, which is what both siblings do: the alert's whole claim is that this integration needs reconnecting, so a page with one more button to press adds a step and no information. The card names no provider in its code. The display name and the route both come from the slug the verdict carried, so a new source reaches the banner with no edit. It shows one card at a time, and the next card appears after the user resolves or dismisses the first.

**The email.** One `delivery_alert` send per broken source, with the key `delivery_alert:{userId}:{source}:{local-day}`. The subject states the loss. The body carries the same sentence and the same link. The template `packages/mailer/src/emails/delivery-alert.tsx` follows the `workflow-blocked` pair.

## The wire carries slugs, not copy

`deliveryAlerts` on `integrationStatusSchema` carries an integration slug and one sentence. It carries no display name and no URL. The web owns both already, so it resolves both at render time; a transmitted label would freeze today's wording into tomorrow's page. The event source slug does not go on the wire either. It keys the email's repeat window server-side, and ADR-0097 item 5 states that the source space and the integration space are different spaces. One sentence must not hold two slug spaces.

The field carries `.default([])`. A browser on a new bundle against a server that has not restarted reads an absent key as an empty list. Without the default, that browser fails the parse and reports every integration as disconnected.

`toDeliveryAlerts` parses each entry with `deliveryAlertSchema.safeParse` and drops a failing entry with a log line. `reason` is a bounded string on that schema, and the web parses the whole status body: one over-long sentence from a future descriptor would fail that parse and blank every integration tile, which is the failure the `.default([])` exists to prevent. One missing banner is the cheaper loss.

The list holds at most one entry per integration. One integration is one repair, so two broken sources behind it would ask the user to press one button twice. Registry order picks the winner, so the choice is stable across reads.

The "already nagged" filter is the server's, not the web's. `nagsOwnCredential` drops an integration that holds an `active` credential row which no active row satisfies the connected rule for. That is the exact state `ScopeGapBanner` and `useGithubNeedsReconnect` render, from the `providers[].missing` list on the same status body, and two cards for one click read as two problems. The first revision applied this test inside the React hook, which left the sweep emailing a state no banner could show. `useDeliveryAlerts` is a thin read now.

## The sweep

`ingress.health_sweep` runs every 6 hours on the ingestion queue. The interval is not the rate limit. The email is limited to one per source per week, so the interval only bounds how long a break stays unreported, and a single failed run still has three more before the day ends.

`delivery_alert` is its own `NOTIFICATION_KINDS` member, added by migration `0126_bitter_lionheart.sql`, rather than a subject under `health_alert`. The 7-day window read pulls a bounded page of recent rows for the kind and matches a key prefix in JavaScript, because `health_alert` contains `_`, which is a `LIKE` wildcard. Sharing the kind with the drift alerts would make that page size depend on how many drift metrics exist, and a page that filled with drift rows would silently stop finding the delivery row and re-send it. The read is `status = 'sent'` only, covered by `email_sends_user_kind_idx`: a queued or failed row means the user was told nothing, so the source still owes them an alert.

A day would nag about a state the banner already shows. A week is long enough to stay news, and short enough that a break in the background gets raised again.

The fan-out scope is `selectEmailableUsers`, in `delivery/emailable-users.ts`, shared with the briefing queue. It is not every `user` row. This is the second recurring outbound fan-out in the codebase, and the first one billed real work against 83 leftover `@example.test` rows before it gained the same filter. One helper is what keeps the two from drifting; `selectBriefingFanoutUsers` is gone.

## Alternatives

- **A briefing line.** Rejected. See **Why not the briefing** above.
- **A second reader that re-derives the cause from the registry.** Rejected. Two folds over one registry answered the no-adapter case oppositely, and only a comment held them together. A discriminator on the value costs one field and cannot drift.
- **The alert rule in `automation/`.** Rejected, and not available. See **Where the code lives**.
- **A cause and a recovery as two independent fields.** Rejected. Four of the nine pairs are meaningless, and a comment is the only thing that can refuse them. One arm per cause makes the compiler do it.
- **One surface only.** Rejected. A banner alone waits for the user to open the app, and #1033 ran for weeks. An email alone is stale by the time the user reads it, and it cannot state that the break is over.
- **A dedicated `delivery_alerts` table.** Rejected. `email_sends` already records what was sent, to whom, and when. A second table would hold the same facts and could disagree with the first.
- **A `deliveryAlerts` payload with display copy and a URL.** Rejected. The web owns both, and a stored label ages.
- **An hourly sweep.** Rejected. The banner already carries the live truth. An hourly pull adds database reads and moves no alert forward, because the email rate limit is a week.
- **The "already nagged" filter in the React hook.** Rejected, after the first revision shipped it there. The email has no React hook, so the two surfaces disagreed.

## Preserved behavior

Workflow readiness is unchanged. Sentry's check order is `main`'s order, so no verdict changes its recovery kind and no workflow moves between `trigger_degraded` and `trigger_not_ready`. `trigger_degraded` and `trigger_not_ready` still follow the recovery kind, as ADR-0097 item 5 states. Every existing producer returns the same healthy or unhealthy verdict it returned before, with one field added. The briefing is byte-identical to `main`. The `health_alert` drift alerts keep their key shape and their behavior, and they now have the `delivery_alert` kind beside them rather than a new subject inside them.

## Residual risk

The GitHub descriptor still cannot detect the exact signature of #1033. It reads credential rows, so it proves only that some `installation_id` is non-null. In #1033 an active row held an installation id that no longer matched the App's installation, so this check reads `healthy: true` and no alert fires. A correct check needs a GitHub API call, which does not belong in the read that builds every integration tile. This ADR delivers the schedule and the surfaces. The descriptor fix is separate work.

`readIntegrationStatus` reads `readGmailDeliveryFacts` twice: once for the `pushStale` column, and once inside Gmail's delivery verdict. That is one extra indexed read per status read. The alternative is a Gmail-shaped parameter on a generic health-reader contract. The docstring in `connections/availability.ts` records the trade.

Recovery is not observed. A source that breaks, is repaired, and breaks again inside 7 days is emailed one time. The banner carries the second break live, so the silence is still broken.

The banner refetches on window focus, with a 30-second `staleTime`. It is not on an interval. A user who leaves the tab open sees the alert on their next focus, not within 30 seconds.

No feature tests. The compiler carries the cause on every producer, because each unhealthy arm requires the field and pins its own recovery. The `zod` parse at the status boundary carries the wire shape. The surface rule is one pure function over the verdict, and nothing else reads the verdict for a user surface.
