# ADR-0100 — A delivery alert is a banner and one email, never a briefing line

**Status.** Accepted (issue #1035, PR #1038). Motivated by incident #1033. Refines ADR-0097 item 5. Amends nothing in ADR-0048. **Amended 2026-10-28 (accepted; slices 1 and 2 built):** a broken connection is also a block in the briefing, and a broken connection stops a quiet morning. The code supplies facts and a model writes the words (see **Revision: the model writes the words**). See the amendment of that date; it reverses "never a briefing line" for this case only.

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

A cause is not enough. The alert rule adds more conditions, so the set of reachable alerts is small and worth naming.

- **A GitHub row that holds an installation id and is no longer active.** GitHub's adapter reads the connected rule (ADR-0093) first: an active row that carries an `installation_id` is healthy. When no row satisfies it, a non-null `installation_id` on **any** row, at any status, is the fact that separates the two unhealthy answers. That column is a durable record that the user once completed Install and Authorize, so App deliveries did flow and have stopped. A revoked or expired row that carries one is `broken`, and it is alertable.
- **A Gmail account whose watch lapsed.** `WATCH_NOT_INSTALLED` in `connections/ingestion/gmail-event-health.ts` is `broken` with recovery `connect gmail`. The verdict is only ever asked of a row that exists, so the user connected Gmail and the watch has since gone.

Two states look alertable and are not.

- **A GitHub row with no installation id.** A classic-OAuth row that predates the App migration (ADR-0052) never received one delivery, so "Alfred stopped receiving GitHub activity" would be false. It reads `never_connected`. `GithubReconnectBanner` already names that row and offers that repair. The first revision read "any row at all" here, which claimed a break that never happened, on the one state the deployment actually holds.
- **Every Sentry verdict.** Sentry's two `broken` arms are a missing `SENTRY_WEBHOOK_CLIENT_SECRET` and more than one connected organization. Both carry `recovery: { kind: "none" }`, because only an operator can act on either. The rule filters both out. Sentry cannot produce an alertable verdict today.

Sentry's check order is `main`'s order, unchanged. An earlier revision put the credential question before the environment question, to improve which reason an operator reads. That reorder was withdrawn. `deliveryProblem` in workflow readiness branches on the **recovery** kind, not on the cause, so the reorder would have turned a deployment with no Client Secret from `trigger_degraded`, where the run defers quietly, into `trigger_not_ready`, where the workflow blocks and the owner is emailed. It bought a better operator log line with an email nobody asked for, and it bought the alert surface nothing, because the rule filters both arms whichever one wins.

## Amendment — 2026-09-12: a non-prod instance is not told to repair a watch it can never install

A dev instance showed `Alfred stopped receiving Gmail activity` for an account that was never broken. The cause is the collision of two correct decisions. `gmailMailboxWritesEnabled()` defaults off outside production (ADR-0081), so `gmail.watch_install` and `gmail.watch_renew` skip and no `metadata.watch` is ever written; the account reads `WATCH_NOT_INSTALLED`, which is `broken` with a `connect gmail` recovery. That verdict is honest — the trigger genuinely cannot fire — but the absence is the environment's choice, not a subscription that lapsed, and the user's reconnect would not install a watch either. The live banner read it as a loss.

The fix is a **fourth alert condition**, not a change to the verdict: `unrepairableHere()` in `connections/delivery-alerts.ts` adds Gmail to the surface rule's suppressed set when the mailbox-write gate is off. `readGmailEventHealth` is untouched, so workflow readiness keeps refusing the Gmail trigger with the same `cause: "broken"` and `recovery: connect`, and the banner and the email go quiet together. The condition is general — an instance cannot ask a user to perform a repair the instance is forbidden from performing — and Gmail is its only member today.

**Rejected alternative.** Return `cause: "unknown"` from the Gmail reader when writes are disabled. It reads well ("Alfred holds no signal"), but the verdict type pins `unknown` to `recovery: { kind: "none" }`, so readiness would move the trigger from `trigger_not_ready` to `trigger_degraded`: the workflow would defer quietly instead of telling the user, changing a second surface for a sentence the alert surface alone owns. The suppression keeps the amendment to the surface rule.

## Amendment — 2026-10-28: a broken connection is a block in the briefing, and a missing row does not prove a disconnect

**Status.** Accepted. Slice 1 is built (items 1 and 2): `gather.broken_connections`, `isQuietMorning`'s `brokenConnectionCount`, and the `BriefingBlockRow` block in the briefing template. Slice 2 is built (item 4), with the revision **The model writes the words**. Slices 3 and 4 are not built. Item 1 was revised on the same day after review; see **Revision to item 1**.

### What happened

Three facts from production on 2026-10-28 show that the two surfaces did not reach the user.

- **The rows that prove a break were deleted.** The October 2026 key rotation used the lost-key path of the vault runbook (`docs/runbooks/oauth-credential-vault-rollout.md`), which runs `delete from integration_credentials`. That removed the GitHub App row and its `installation_id`. The GitHub adapter then had no row with an installation id, so it read `never_connected`, and the alert rule stayed silent. GitHub App webhook rows stopped on 2026-10-22. `email_sends` holds zero `delivery_alert` rows. Neither the banner nor the sweep spoke.
- **An MCP connection showed `ready` with secrets that do not open.** The Sentry MCP row kept `status = 'ready'` after the rotation. Its sealed OAuth secrets did not open with the current key. The OAuth provider finds that only when a call uses the connection (`mcp_oauth_credential_unopenable`, `connections/mcp/oauth.ts`). No call used it for weeks, so nothing found it. This ADR does not fold MCP connections at all.
- **The briefing said that it saw everything.** The 2026-10-28 morning briefing could not check three loops. A dry run over the same window wrote "Nothing new overnight needs your attention." The briefing claimed a complete view while one delivery source and one MCP connection were dark.

The banner waits for the user to open the app. The weekly email waits for a verdict that the rule can see. The briefing is the one surface that the user reads every day, and it was the surface that this ADR kept silent.

### Decisions

1. **The briefing carries one fixed block for broken connections.** This reverses "never a briefing line" for this case only. The banner and the weekly email do not change. The block is not composer prose. The send step renders it from the alert rule's output, below the body, in the morning and the evening template. The composer cannot drop it, change its words, or move it. The block has one row per integration: the display name, the verdict's sentence, and the connect link that the banner uses. The block shows the same set that the banner and the sweep show, because all three call the same rule (extended by items 4 and 5). The composer also receives the list as a fact, so that its prose does not claim a complete view. The block does not depend on the composer. ADR-0117 generalizes this block to every briefing input. Broken connections are its first producer.

   **Revision to item 1 (2026-10-28, after review of slice 1).** Five points of item 1 change.
   - **The set.** The block does not apply the banner's credential-nag dedup (`nagsOwnCredential`). That dedup exists because a credential banner on the same screen already asks for the same click. The email has no such banner. Example: an inactive GitHub App row with an `installation_id`, beside an active OAuth row without one. GitHub delivery is `broken`, the reconnect banner covers it in the app, and the dedup removed it from the briefing. So the block reads `readBrokenConnections`, which is the rule without the dedup. The banner and the sweep keep the dedup.
   - **The claim.** A broken delivery does not prove that the gathered data is missing. A lapsed Gmail watch still has the history poll, so the briefing can show current mail. The block therefore says "Alfred stopped receiving updates from these connections", not "Alfred cannot see these sources". The composer fact says the same, and it tells the composer not to claim a complete view of those sources. The gather field is `broken_connections`, not an ADR-0117 `unavailable` input. ADR-0117 can mark an input `unavailable` only when the gather proves missing coverage.
   - **A failed read.** The banner reads an alert fault as no alerts, so that one fault does not blank every tile. The briefing must not do that: an empty list lets a quiet morning suppress a briefing that could not check its connections. The briefing read throws, the gather marks the row `failed`, and the next run retries it.
   - **The link.** The row links to the banner's connect route (`integrationConnectPath` on the API origin), as item 1 states. The weekly sweep email still links to the integration page.
   - **A resumed send.** A run that resumes from a `composed` row reads the connections again. It compares the exact facts supplied to the composer, independent of row order. A changed label, cause, scope, or other fact requires a fresh compose even when the connection ids stay the same. The send step parses persisted state before use, so an older queued send receives the empty-notice default. A send-time body downgrade preserves the notices and other stored fields.

2. **A broken connection stops a quiet morning.** `isQuietMorning` (`briefings/read.ts`) gets the count of alertable connections. A count above zero sends the morning. The block repeats each day that the break continues. A briefing that cannot see a source must say so on each day that it cannot see it. To stop the block, the user reconnects or disconnects.
3. **A missing credential row does not prove that the user disconnected.** This ADR reads "a non-null `installation_id` on any row" as the durable record that deliveries flowed. An operator action must not erase that record.
   - **The operator path keeps the row.** A lost key or a key rotation sets `status = 'needs_reauth'` and clears the sealed secrets. It does not delete the row. This needs `access_token` to be nullable when the status is not `active`, with a CHECK that keeps it required for an `active` row. The runbook's lost-key step changes to match.
   - **A user disconnect still deletes the row.** `deleteIntegrationCredential` (`packages/integrations/src/shared/credentials.ts`) does not change. So "no row" keeps one meaning: the user never connected, or the user chose to disconnect. The rule stays silent for both.
4. **The rule folds MCP connections.** An MCP connection is alertable when its status is `auth_required` or `failed`, or when its sealed OAuth secrets do not open with the current key. The second check is local and makes no network call. It is the same test that the OAuth provider runs before a call. The sweep, the briefing gather, and the integration-status read run it, so a connection that no call uses cannot stay `ready` with dead secrets. The repair route selects the stored authentication mode: OAuth can ask for new consent; an API-key or no-auth connection reopens through the connection manager without OAuth discovery. The client and the route share the OAuth selection rule, with API keys first. A rejected API key still needs replacement through the integrations page. The row shows the connection's label.
5. **The briefing gather closes the #1033 residual risk for GitHub.** **Residual risk** below says that a correct GitHub check needs a GitHub API call, and that the call does not belong in the tile read. The morning gather already makes that call: the merged-pull read of the ADR-0062 amendment of 2026-10-27. When that read proves a merge in a repository that delivered App webhooks before, and no App delivery for that repository arrived in the window, GitHub App delivery is `broken` with recovery `connect github`. This is a fact from two reads, not a guess. The condition "a repository that delivered webhooks before" stops a false alert for a repository where the App was never installed. This verdict appears in the briefing block only, because only the gather makes the read.

### Revision: the model writes the words (2026-10-28, owner decision during slice 2)

The owner decided that Alfred's words about a broken connection come from a model, not from the code. The code supplies facts. The model reasons from them as a personal assistant does: what broke, what it costs the user, and what the fix takes. This revision replaces the fixed wording of item 1. It keeps the guarantee that the rejected alternative **Composer prose for the block** protected: a broken connection cannot be dropped.

- **Facts, not sentences.** `mcpConnectionAlertSchema` carries `status`, `credentialUnopenable`, `missingScopes` (the consent ask minus the grant), a sanitized `lastError`, and `lastConnectedAt`. It carries no `reason`. A delivery alert keeps its verdict `reason`, and the model reads it as a fact. `connections/broken-connection-facts.ts` turns both kinds into fact lines with one key each (`integration:{slug}`, `mcp:{connectionId}`), and holds `BROKEN_CONNECTION_GUIDANCE`, the principles that both model surfaces read.
- **The briefing.** The composer writes one `connectionNotices` entry per key in `dump_briefing`. The compose step checks that each key has a notice. A missing key joins the open-ask re-prompt (one aimed retry). A key that still has no notice after the retry gets a bare row: the name and the link only. The code owns the name, the link, and the row order, so the composer cannot drop a row or change a link. The notices are stored in `full_briefing.connectionNotices`, so a resumed send reuses them.
- **The alert email.** The weekly sweep asks the `cheap` route for a headline and a body from the same facts. The template adds the button and the link. A model failure sends a bare email with the button, because a silent alert is the failure that this surface exists to prevent.
- **The banner.** The banner shows facts as labels: the connection name, then a dead saved sign-in, the missing scopes, or the last error. The server sends no sentence.

What the composer can still get wrong: a notice can be weak or vague. The check proves that each connection has a notice. It does not prove that the notice is good.

### Which breaks Alfred can know

| Break | Signal | Who is told |
| --- | --- | --- |
| A GitHub row with an installation id that is no longer active | the credential row | user (already) |
| A Gmail watch that lapsed | ingestion state | user (already) |
| An operator removed the credentials | the kept `needs_reauth` row (item 3) | user, after item 3 |
| MCP secrets that do not open | the local envelope test (item 4) | user |
| An MCP connection in `auth_required` or `failed` | `mcp_connections.status` (item 4) | user |
| The App is installed but its credential is lost or does not match (#1033) | merges with no deliveries (item 5) | user, in the briefing |
| A delivery names an installation that no row owns | `ingress.no_owner` (#1583) | operator only; the delivery names no user |
| The user disconnected on purpose | no row | nobody, by design |

### Why the old reasons against the briefing do not hold here

- *The briefing suppresses a quiet morning.* Item 2 removes that path. A broken connection is a reason to send.
- *A broken subscription needs a button, not prose.* The block is a rendered row with a link, not a sentence in the narrative.
- *A report of its own blindness asks the user to trust the rest of the page.* The opposite happened. The briefing told the user that nothing needed them while it was blind. A row that names the dark source makes the rest of the page honest.

### Rejected alternatives

- **Infer "connected once" from provider data**, for example `integration_objects` or `documents` rows from that provider. Those rows stay after a deliberate disconnect too, so the rule would alert after a real disconnect.
- **A disconnect tombstone table.** It records the same fact as a kept row with a status, and it can disagree with the credential table. Item 3 keeps one source.
- **Composer prose for the block.** On 2026-10-28 the composer dropped an open item because a rule told it to drop rows it could not check. A block that the template renders cannot be dropped.
- **A daily delivery email in place of the block.** It adds a second daily email beside the briefing. The block costs no new send.

### Preserved behavior

The cause vocabulary, the three-arm `EventDeliveryFailure` union, workflow readiness, and the banner and the email keep their behavior. Sentry's two operator-only `broken` arms stay silent. The 2026-09-12 condition stays: an instance does not ask for a repair that it cannot perform. A user disconnect still deletes the credential row.

### Residual risk

- The block repeats daily. A user who keeps a broken connection on purpose sees it each day until they disconnect.
- Item 5 also fires when GitHub itself stops sending webhooks. The row is still true: Alfred did not receive GitHub activity.
- Item 5 runs only when the gather makes the merged-pull read. The evening slot and a failed read fall back to items 3 and 4.

### Implementation slices

1. The briefing block and the quiet-morning input (items 1 and 2).
2. The MCP fold (item 4).
3. The merges-with-no-deliveries verdict (item 5).
4. The kept-row operator path: the `access_token` CHECK migration, the rotation path, and the runbook (item 3).

## Amendment — 2026-10-31: Sentry is no longer an event source

The `sentry` inbound source is deleted (ADR-0093 and ADR-0097, same date). Its two operator-only `broken` arms and its `never_connected` verdict are gone with the descriptor. The text above that names Sentry describes the state before this date. GitHub and Gmail stay the two producers of an alertable verdict.

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

`delivery_alert` is its own `NOTIFICATION_KINDS` member, added by migration `0126_bitter_lionheart.sql`, rather than a subject under `health_alert`. The 7-day window read matches a key prefix in JavaScript, because `health_alert` contains `_`, which is a `LIKE` wildcard. It reads every page, with an exclusive primary-key cursor. The old single-page limit was safe only for a bounded source list; arbitrary MCP connection ids can exceed it and must not make a recent alert disappear from the repeat check. The read is `status = 'sent'` only, covered by `email_sends_user_kind_idx`: a queued or failed row means the user was told nothing, so the source still owes them an alert.

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
