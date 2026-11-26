# ADR-0134 — External provider config is declared in the repo and verified loud (ACCEPTED — 2026-11-26; first entry and the gate not built)

**Status.** Accepted, not built. Owner decision, 2026-11-26, after the GitHub App CI-lane fault (below). Extends [ADR-0128](./ADR-0128-railway-deployment-config-is-an-alchemy-program.md) (the repo declares the deployment topology; this extends the same law to provider-side configuration). Relates to [ADR-0093](./ADR-0093-integration-registry-one-entry-per-integration.md) (the registry owns provider identity), [ADR-0097](./ADR-0097-a-tiered-ingress-verifies-every-inbound-webhook-before-it-fires-a-trigger.md) (the raw receipt tier), and [ADR-0125](./ADR-0125-github-reads-go-through-the-github-mcp.md).

**Problem.** On 2026-11-25 a `deploy-production` run on main failed (commit `2c73512`, 04:52 UTC); two later runs on main passed at 05:26 and 06:48 the same morning. Three briefings in a row — Nov 25 evening, Nov 26 morning, Nov 26 evening — kept surfacing the failure as open, because the closure path (`ci_target` folds to `resolved` from a `check_suite` webhook, #1093) could never fire: the GitHub App `alfred-99yash` held no Checks permission and no `check_suite` subscription, so no delivery ever arrived (#1167 notes the empty lane). The gap was documented in `docs/reference/operations.md` with a runbook marked "not done yet" — the repo *knew* the config was missing and could not see it drift. The provider-side config (App permissions, webhook subscriptions) lived only in GitHub's settings UI and three drifting prose descriptions: the UI, `operations.md`, and the consuming code (`event-triggers.ts`, which already typed `check_suite`). GitHub offers no API to write an App's permissions or subscriptions (the mutation is always a sudo-mode UI pass), but `GET /app` with an App JWT reads the live config — the write side is manual, the read side is free.

**Decision.** Provider-side configuration becomes **declared external configuration**: one generic primitive in `infra/` whose entries declare (a) desired state, (b) a verification source, and (c) named capability requirements. The GitHub App is entry #1. A deploy-time gate diffs declared state against the live config and fails loud, naming the exact UI switches. A chat-side diagnosis read shares the checker and answers "can Alfred do X?" — the granted-versus-required diff — so a missing grant is discovered before a task needs it, not after days of wrong briefings. Remediation is model-guided: the verdict names the settings URL and the switches, and the model walks the owner through (or drives, via the browser) the UI pass — the path proven on 2026-11-26, when the owner and the agent ran the runbook together in one session.

**Evidence.** The fault and the fix, measured 2026-11-26: three briefings surfaced the closed loop; the App held five subscribed events and no Checks permission (operations.md, stale since 2026-09-23); after the UI pass the `workflow_dispatch` run 45829122662 completed and its `check_suite.completed` delivery returned **200** from the ingress (delivery `5c3c5ede-e99d-11f1-92e4-a33c12ce081b`, hook target 3994830), with `installation.new_permissions_accepted` at 18:56 IST. Residual risk, stated: drift between deploys sits undetected until the next push to main (accepted at the owner's deploy cadence; no scheduled worker).

## D1 — One declaration, one authority, checked relations

- `infra/src/github-app.ts` (the first entry) owns the App's granted permissions and subscribed events as the single source of truth. Nothing else in the repo restates them.
- `packages/contracts/src/event-triggers.ts` stays independent — it describes what Alfred *consumes*, not what GitHub *publishes*. The gate asserts the subset relation: every consumed event type must be subscribed. GitHub may be subscribed to more; a consumed-but-unsubscribed type fails the deploy.
- `docs/reference/operations.md` keeps the history and the runbooks, points at the declaration, and never holds the authoritative list again.

## D2 — The gate runs inside `infra adopt` and fails loud

- The checker runs where declared state is applied: inside the alchemy program, next to `VerifyDatabases`. It fetches `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` from the Railway server-service variables with the token it already holds — no new GitHub secrets, one trust domain.
- A drift failure fails the deploy and names the fix: which permission, which event, which settings page. The failure is a work order, not an error code.
- One checker function, three surfaces: the deploy gate, a `pnpm` script for local runs, and the chat-side diagnosis read (D4). No scheduled worker: drift only happens by deliberate human hands, and deploys run daily.

## D3 — Two tiers: enforced granted, diagnostic required

- The declaration carries the **granted** state (enforced — consumed-not-granted fails the deploy) and per-capability **required** state (diagnostic only): a named capability lists the permissions and events it needs.
- A capability whose grants are missing never blocks a deploy. "Make and edit PRs" may be declared required for months before its permissions are granted; the gap surfaces in diagnosis, not in CI.
- Granting is a guided UI pass, not a deploy artifact.

## D4 — The diagnosis read is a generic surface; secrets never cross into the model

- The chat read returns a fixed verdict shape: declared vs live config, consumed-but-undelivered drift, and per-capability gaps with the missing switches and the settings URLs. The JWT minting and the `GET /app` call happen behind the tool boundary; no credential value crosses into model context (the same redaction law that governs every tool result).
- The read is generic over entries, not GitHub-specific: the next entry (Sentry webhooks, the `gmail-push-prod` subscription) plugs into the same verdict shape.

## D5 — Build order

1. The declaration (`infra/src/github-app.ts`) with the GitHub App's state as applied on 2026-11-26 (Checks read-only; six subscribed events: `issues`, `pull_request`, `pull_request_review`, `push`, `repository_dispatch`, `check_suite`).
2. The checker shared package and the `infra adopt` gate.
3. The chat diagnosis read.
4. The `pnpm` script surface.
