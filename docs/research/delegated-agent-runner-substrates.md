# Delegated agent runner substrates — credentialed, network-enabled coding task

**Question:** Alfred (Node 22 Elysia API on Railway, unprivileged container, GitHub App with
installation tokens already wired up at `packages/integrations/src/github/app.ts`, BullMQ workers,
Postgres) wants to hand a bounded software-engineering task (stack trace + repo) to an **ephemeral
remote/child environment that needs broad network** (git, npm/PyPI, the Anthropic API) **and a scoped
credential** (push a branch + open a PR on exactly one repo). Output is a PR a human reviews.

**This is the opposite case from `code-mode-sandbox-feasibility.md`.** That doc researched a
network-less, credential-less V8/WASM isolate for model-authored JS with no data-custody story. Here,
network access and a real credential are the *requirement*, not the threat — the data shipped in (the
user's own GitHub-hosted source + a stack trace) is not third-party custody-sensitive the way private
Gmail/Drive reads were for ADR-0087. Do not re-derive that doc's conclusions; this one is about
**containment of a credentialed, internet-facing job**, not about eliminating network entirely.

**Date:** 2026-07-25. Primary sources: GitHub REST/Actions docs, Vercel Sandbox docs, E2B/Daytona/Modal
docs, Fly.io Machines API docs, Railway API docs, `code.claude.com` (Claude Code CLI) and
`platform.claude.com` (Claude API / Managed Agents) docs — all fetched live and URLs inline.
Version-sensitive facts are date-stamped.

---

## Executive summary — verdicts

| # | Substrate | Verdict | One-line |
|---|---|---|---|
| 1 | GitHub Actions via `workflow_dispatch` + App token | **GO** | Cheapest to build — Alfred already mints installation tokens; but must use the App token (not the job's default `GITHUB_TOKEN`) for the push/PR so the repo's own CI actually fires on it, and must design completion notice around the webhook Alfred's App already receives. |
| 2 | Vercel Sandbox | **GO, credentialed case only** | Triggerable from a plain Node/Railway process via a Vercel **access token** (not just Vercel-hosted OIDC); GA firewall supports domain allowlisting and can **broker credentials so they never enter the sandbox**; but completion is synchronous SDK polling only — no push callback — so a BullMQ worker must hold the connection or re-poll. |
| 3 | E2B / Daytona / Modal | **CONDITIONAL GO (Daytona/E2B), WEAK (Modal)** | All three: Node-triggerable, API-key auth, env-var secret injection. Daytona and E2B both document a real sandbox-side outbound allow/deny-list; Modal's "egress control" is really *static-IP-for-allowlisting-by-the-destination*, not an outbound firewall. Daytona has state-change webhooks; E2B and Modal are poll/await only. |
| 4 | Fly.io Machines API / Railway API (DIY) | **Fly: GO. Railway: NO-GO for one-off jobs** | Fly Machines API cleanly creates a one-off `auto_destroy` machine via REST + Bearer token — a real DIY option. Railway's public API has no documented one-off/ephemeral job-creation mutation; Railway "cron jobs" are dashboard/schedule-configured services, not API-triggered one-shot containers. |
| 5 | Headless Claude Code CLI (`claude -p`) | **GO** | `claude -p --output-format json --permission-mode dontAsk --allowedTools "Bash(git *),Read,Edit,Write" --max-turns N --max-budget-usd N` is the documented non-interactive invocation; cost/turns are bounded and reported; the diff is retrieved by reading the working tree (`git diff`) after exit, or by giving Claude the `gh`/`git` bash tools to push + open the PR itself. |
| 6 | **Claude Managed Agents (CMA)** — Anthropic-hosted agent loop + sandbox | **GO — closest purpose-built fit** | Anthropic runs the Claude Code-equivalent loop *and* hosts the container; a `github_repository` session resource clones one repo with a scoped PAT that **never enters the sandbox** (an Anthropic-side git proxy injects it); a `session.status_terminated` **webhook** is the completion signal (no polling needed); still beta (`managed-agents-2026-04-01`). |

**Bottom line:** three credible, complementary paths, not one winner — see **Recommendation for Alfred**.

---

## 1. GitHub Actions via `workflow_dispatch` triggered by an App installation token

### Triggering the run

`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` with body `{"ref": "...",
"inputs": {...}}` — up to 25 top-level input properties, 65,535-char payload cap, and **the workflow
file must exist on the ref you're targeting for dispatch to accept it** (in practice: exist on the
default branch) (`https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event`,
`https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch`).
GitHub's docs state "OAuth tokens and personal access tokens (classic) need the `repo` scope to use
this endpoint" — the fine-grained-PAT / GitHub-App-installation-token equivalent permission wasn't
captured verbatim in this fetch. **Not fully verified: confirm empirically that Alfred's installation
token (minted via `getInstallationToken()` at `packages/integrations/src/github/app.ts:102`) can call
this endpoint** — GitHub Apps need the **Actions: write** repository permission for this class of
call; Alfred's App manifest permission set should be checked/extended before relying on it.

### Getting a token that can push a branch and open a PR

Three options, in practice:
- **The job's default `GITHUB_TOKEN`**, scoped by the workflow's `permissions:` block (e.g.
  `contents: write`, `pull-requests: write`) — simplest, but see the gotcha below.
- **A GitHub App installation token**, minted inside the job (or handed to it) — Alfred already has
  this machinery for its own App; the same App's installation token can be used *inside the Action*
  instead of `GITHUB_TOKEN` if the workflow needs the App's identity/permissions rather than the
  Actions-scoped token.
- **A classic PAT** stored as a secret — works but is a long-lived, broadly-scoped credential; avoid.

(`https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication`)

### The documented gotcha: `GITHUB_TOKEN`-triggered events don't trigger further workflows

> "events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following
> exceptions: `workflow_dispatch` and `repository_dispatch` events always create workflow runs."
> (`https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow`)

**This matters concretely for Alfred's design:** if the delegated job pushes its branch and opens the
PR using the default `GITHUB_TOKEN`, the repo's *own* `pull_request`-triggered CI (lint/test workflows)
will **not** fire on that PR — the human reviewer sees a PR with no CI status. The documented fix is to
push/open the PR with a **PAT or GitHub App installation token** instead of `GITHUB_TOKEN`
(same source). Since Alfred already mints App installation tokens for its own GitHub integration, the
delegated job should authenticate its `git push`/`gh pr create` with that installation token, not the
Actions-native `GITHUB_TOKEN` — this is a one-line design decision with a real, otherwise-silent
consequence (PR opens with no checks).

### Learning the run's outcome

- **`workflow_run` webhook/event**: fires on a specified workflow's `requested`/`completed` states;
  carries `github.event.workflow_run.id`, `.conclusion`, head branch/SHA, and access to artifacts
  (`https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_run`).
  Chaining is capped: **"You can't use `workflow_run` to chain together more than three levels of
  workflows."**
- **Checks API** (not separately verified in this pass — GitHub Apps installed with `checks: write`
  can create/read check runs/suites; a natural fit since Alfred's App already receives webhooks).
- Because Alfred's GitHub App is already webhook-subscribed (ADR-0052, `project_github_app_migration`
  in memory), the cleanest path is to have Alfred's existing webhook receiver subscribe to
  `workflow_run` (or simply watch for the `pull_request` `opened` event the delegated job itself
  produces) rather than polling the Actions API.

### Job timeout / concurrency limits

- GitHub-hosted runner: **max 6 hours per job**. Self-hosted runner: **max 5 days per job**.
- Whole workflow run: **max 35 days** (cancelled past that).
- Concurrent jobs: 20 (Free) / 40 (Pro) / 60 (Team, or 1,000 on larger runners) / 500 (Enterprise, or
  1,000 on larger runners).
  (`https://docs.github.com/en/actions/reference/limits`)

### Egress control — GitHub-hosted runners have no stable allowlist; self-hosted gives full control

GitHub-hosted runner IPs are drawn from a large, rotating range published at the GitHub Meta API
(`api.github.com/meta` → `actions` key) — there is no fixed, small IP set a downstream service (or
Alfred) could allowlist, and no per-job outbound-firewall/allowlist knob is exposed on GitHub-hosted
runners. GitHub's own guidance for orgs that need IP-allowlisting is to use **larger runners** (Team/
Enterprise), which get a **semi-static, dedicated IP range** per runner group, or to use **self-hosted
runners**, where egress is whatever the host box/network allows — full control, but full ownership.
For a workflow_dispatch-only job with no fork-PR surface, this reduces to the same "operate your own
box" trade-off as §4's DIY runners.
(`https://docs.github.com/en/actions/reference/limits`, `https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners/about-github-hosted-runners`)

### Pricing

GitHub-hosted Linux 2-core runner: **$0.006/minute** ($0.008 for 4-core, scaling up). Included free
minutes (Linux-equivalent) per month: **2,000 (Free personal/org)**, **3,000 (Pro/Team)**, **50,000
(Enterprise Cloud)** — self-hosted runners are always free of Actions-minute billing (you pay only for
the box). (`https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions`)

### `pull_request` vs `pull_request_target` — the privilege-escalation question, precisely

- **`pull_request` from a fork**: "With the exception of `GITHUB_TOKEN`, secrets are not passed to the
  runner when a workflow is triggered from a forked repository. The `GITHUB_TOKEN` has read-only
  permissions in pull requests from forked repositories."
- **`pull_request` from a branch in the *same* repository** (not a fork): the workflow's normal
  `permissions:`-scoped `GITHUB_TOKEN` and secrets **are** available — GitHub's fork restriction is
  specifically about *forked* PRs, not same-repo branches.
- **`pull_request_target`**: "This event runs in the context of the default branch of the base
  repository, rather than in the context of the merge commit, as the `pull_request` event does" — it
  gets the full-permission token and secrets *even for fork PRs*, which is exactly why GitHub warns:
  "Running untrusted code on the `pull_request_target` trigger may lead to security vulnerabilities."
  The escalation only materializes if a `pull_request_target` workflow **also checks out and executes
  the fork PR's own code** — that combination hands attacker-controlled code a token with write access
  and secrets.
  (`https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#pull_request`)

**Relevance to Alfred's design:** the delegated-agent job operates on Alfred's *own* branches in its
*own* repo (not a fork PR), so the classic `pull_request_target` + untrusted-fork-checkout escalation
class doesn't apply here. The residual risk is different: the *agent's own generated code*, run inside
the CI job with a real credential, is the "untrusted" element — containment has to come from scoping
the token (branch push + PR only, no merge, no admin) and from human review before merge, not from the
fork/same-repo distinction.

### Self-hosted runner option

GitHub is blunt: self-hosted runners should **"almost never be used for public repositories"** because
"any user can open pull requests against the repository and compromise the environment," gaining
"access to secrets and the `GITHUB_TOKEN`." The recommended mitigation is **ephemeral, just-in-time
(JIT) runners** that "perform at most one job before being automatically removed" — but GitHub still
cautions that hardware reuse needs "automation to ensure the JIT runner uses a clean environment"
(`https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`).
For Alfred (private repo, workflow_dispatch-only — no fork-PR surface), self-hosting is a legitimate
way to get egress control the GitHub-hosted runner doesn't offer (see §4 for the DIY-runner framing) —
but it collapses into "operate your own ephemeral container," i.e. option 4.

### Single biggest risk
**Silent CI-skip on the generated PR** if the push/PR-open uses the default `GITHUB_TOKEN` instead of
the App installation token — the PR looks normal but has no check runs, and nothing errors to tell you
why.

---

## 2. Vercel Sandbox — what's different for the credentialed case

`code-mode-sandbox-feasibility.md` §5 covered Vercel Sandbox for the network-less isolate case and
rejected it on **data custody** (private reads would leave Alfred's infra). That objection is exactly
what the credentialed case *doesn't* have — the data here (the user's own GitHub repo + a stack trace)
is not the same custody class as private Gmail/Drive reads. Re-checking only what's new for this case:

### Triggerable from a non-Vercel Node process — yes, via access token

> "Access tokens: Use access tokens when `VERCEL_OIDC_TOKEN` is unavailable, such as in external CI/CD
> systems or non-Vercel environments."
(`https://vercel.com/docs/sandbox/concepts/authentication`, referenced from
`https://vercel.com/docs/sandbox`) — so Alfred's Railway-hosted Elysia process can call `@vercel/sandbox`
directly with a Vercel access token; this is not restricted to Vercel-hosted callers, and OIDC is only
the *recommended* mode when running on Vercel's own platform.

### Duration / vCPU / pricing (checked 2026-07-25, last-updated stamp on pricing page 2026-06-16 — **no
material change from the 2026-07-23 snapshot** in the sibling doc)

- Default sandbox timeout **5 minutes**; extend with `sandbox.extendTimeout()`.
- Max runtime: **45 min (Hobby) / 24 h (Pro, Enterprise)** — unchanged.
- vCPU: 1 or even 2–32 depending on plan (Hobby max 4, Pro max 8, Enterprise max 32); default 2 vCPU,
  2 GB RAM per vCPU.
- Pricing: Active CPU $0.128/vCPU-hr, Provisioned Memory $0.0212/GB-hr, Creations $0.60/1M, **Data
  Transfer $0.15/GB** (downloads — npm/PyPI/git — are free; only egress you *send* + exposed-port
  traffic is billed), Snapshot Storage $0.08/GB-month.
- Concurrency: 10 (Hobby) / 2,000 (Pro, Enterprise).
- Region: **`iad1` only** — unchanged.
(`https://vercel.com/docs/sandbox/pricing`)

### Egress allowlist per sandbox — yes, GA, and it can hide the credential too

Confirmed directly against the firewall doc (`https://vercel.com/docs/sandbox/concepts/firewall`,
last-updated 2026-06-30, no beta tag): three modes — **`allow-all`** (default), **`deny-all`**, and a
**user-defined domain allowlist** (deny-by-default; specific domains, wildcard supported) — so egress
can be scoped to exactly `github.com` + `registry.npmjs.org` + `pypi.org` + `api.anthropic.com`. Policy
is live-updatable mid-run without restarting the sandbox. The firewall also documents **credentials
brokering**: it can inject an API key/header into egress traffic bound for an allowed domain, so a
credential (e.g. a GitHub token) **never enters the sandbox filesystem/env at all** — the sandbox process
never holds the secret it's using. This is a materially stronger credential-containment property than
plain `env`-var injection (below) and is the same shape of guarantee Managed Agents offers in §6.

### Secret injection — yes, at create time and per-command

`Sandbox.create({ env: {...} })` sets default env vars for all commands in the sandbox;
`sandbox.runCommand({ env: {...} })` overrides per-command. Confirmed field:
`env: Record<string, string>` on both `Sandbox.create()` and `runCommand()`
(`https://vercel.com/docs/sandbox/sdk-reference`). This is a good fit for a short-lived, scoped GitHub
token: mint it fresh per run and pass as `env`, never bake into a snapshot/image.

### How a caller learns completion — synchronous only, no callback

`sandbox.runCommand()` blocks until exit by default (`Promise<CommandFinished>`); pass `detached: true`
to get a live `Command` back immediately and call `command.wait()` later, which resolves once the
process exits and populates `exitCode`/`durationMs`. **There is no async completion webhook or
push notification** — the calling process (or something holding its handle) must stay alive to await
`wait()`, or poll `sandbox.getCommand(cmdId)` later to check status
(`https://vercel.com/docs/sandbox/sdk-reference`). For Alfred, this means the BullMQ worker that kicked
off the sandbox run must itself stay the "owner" of that job (hold the connection or re-enter to poll)
— there's no equivalent of a GitHub Actions `workflow_run` webhook or CMA's session-webhook to lean on.

### Single biggest risk
**No push-based completion signal.** A worker crash/restart mid-run loses the ability to `wait()` on
the in-flight command; recovery requires `sandbox.get(name)` + `sandbox.getCommand(cmdId)` polling
logic that must be built by hand, unlike GitHub Actions (webhook) or CMA (session webhook).

---

## 3. E2B, Daytona, Modal

| Axis | E2B | Daytona | Modal |
|---|---|---|---|
| Auth from Node server | API key (`E2B_API_KEY` env var), `Sandbox.create()` in the JS/TS SDK | API key, `new Daytona({apiKey})` then `daytona.create()` | API-token auth (`modal setup`); first-class JS/TS **and** Go SDKs alongside Python for calling Functions/Sandboxes |
| Per-sandbox lifetime | **Hobby: 1 h max session. Pro ($150/mo + usage): 24 h max**, up to 100 concurrent (1,100 purchasable) (`https://e2b.dev/pricing`) | Not found in a duration-limit page during this pass — billing is per-resource-reserved, active vs stopped states charged differently (`https://www.daytona.io/docs/en/billing`) — **treat max lifetime as unverified; check before relying on long-running jobs** | Default 5 min timeout, **configurable up to 24 h** via `timeout` on `Sandbox.create()`; separate `idle_timeout` for auto-termination on inactivity (`https://modal.com/docs/guide/sandbox`) |
| Secret injection | Not confirmed in this pass beyond general SDK env-var support implied by quickstart examples — **not documented in the pages fetched; verify against E2B's env-vars page before relying** | `daytona.create()`; env var injection referenced in nav (`/docs/en/secrets`) but not independently confirmed in this pass | `modal.Secret.from_dict({...})` passed to `Sandbox.create()` — confirmed, documented |
| Egress/network policy | **Allow-all by default** — "every sandbox has outbound access to the internet by default"; can be restricted to deny-all or scoped to domain/CIDR allow/deny lists via `network.denyOut`/`allowOut` (SNI-based domain matching), live-updatable via `updateNetwork()` (`https://e2b.dev/docs/sandbox/internet-access`) | **Most explicit of the three**: `networkAllowList` (CIDR blocks, max 10), `domainAllowList` (DNS domains incl. wildcard, max 20), `networkBlockAll` — mutually exclusive, settable per sandbox; lower account tiers (1–2) have org-level restrictions that override sandbox settings; tiers 3–4 default to full internet access and can further restrict (`https://www.daytona.io/docs/en/network-limits`) | **"Proxies" give the sandbox a static outbound IP so the *destination* can allowlist Modal** — this is the inverse of an egress firewall (nothing stops the sandbox reaching arbitrary hosts; it just gives you a stable IP to allowlist elsewhere) (`https://modal.com/docs/guide/proxy-ips`). No host-level egress-restriction found. |
| Completion callback vs polling | Not documented — no webhook found in the pages fetched | **Webhooks exist**, confirmed: `sandbox.created` and `sandbox.state.updated` (previous/new state) events — usable to infer e.g. `started`→`stopped`, but there's no dedicated "job/command done" event distinct from sandbox state (`https://www.daytona.io/docs/en/webhooks`) | No webhook found; `https://modal.com/docs/guide/webhooks` documents only *inbound* web endpoints for triggering Functions, not completion callbacks — completion is poll-only via `Sandbox.poll()`/`.returncode` |
| Pricing | Per-second, CPU $0.000014/s (1 vCPU) to $0.000112/s (8 vCPU); RAM $0.0000045/GiB/s; Hobby $100 one-time credit | Pay-as-you-go, per-resource-reserved (active vs stopped states billed differently); **$200 free credit on signup (no card required)**, startup program up to **$50k credits**; no published flat per-second Linux-sandbox rate found in this pass (`https://www.daytona.io/pricing`) | CPU $0.0000131/core/s (standard) or $0.00003942/core/s (Sandbox tier); RAM $0.00000222/GiB/s (standard) or $0.00000667/GiB/s (Sandbox tier); Starter $30/mo free credit, Team $100/mo free credit at $250/mo base |
| Self-host / BYOC | **Not documented** — `https://e2b.dev/docs/self-hosting` 404s; no managed BYOC tier found | **Yes — "Bring Your Own Compute"**: customer-operated runner nodes + proxy/snapshot-manager/SSH-gateway services deployed via Daytona's Helm charts (`daytona-region` chart) into a customer's own Kubernetes cluster, forming a "custom region" with no imposed concurrency limits (`https://www.daytona.io/docs/en/bring-your-own-compute`). **Caveat:** Daytona's OSS repo was reported **made closed-source in June 2026**, with the open-source line archived/unmaintained — a vendor-durability signal for anyone relying on BYOC/self-host long-term (search-derived; re-verify against Daytona's own changelog before depending on it) | **Not documented** — no self-host/on-prem page found in this pass |

**Single biggest risk of each:**
- **E2B:** egress control is now confirmed documented, but secrets injection and completion signaling
  are still thin (no dedicated secrets-API page, no webhook found) — before betting on it, those two
  gaps need direct SDK-repo or support-channel verification, not just doc-site fetches.
- **Daytona:** best-documented egress control and the only one with a real BYOC/self-host story, but
  its account-tier gating (network restrictions differ by tier 1–2 vs 3–4) means the actual behavior
  Alfred gets depends on which tier it's provisioned into — verify tier before assuming
  `domainAllowList` is honored — and its reported June-2026 open-source-to-closed-source pivot is a
  durability signal worth re-verifying before leaning on BYOC/self-host long-term.
- **Modal:** "Proxies" solve the *opposite* problem from what Alfred needs (giving Modal a stable IP for
  others to allowlist, not restricting what Modal's sandbox can reach) — there is no documented way to
  stop the sandbox from reaching arbitrary hosts, which matters if the delegated task's blast radius
  (a compromised or misbehaving agent run) needs to be network-bounded.

---

## 4. Fly.io Machines API and Railway's own API — DIY ephemeral runner

### Fly.io Machines API — GO

- **Create**: `POST /v1/apps/{app_name}/machines` with `config.image`, `config.env` (secrets/env
  vars), and for one-off-job behavior: `config.restart.policy: "no"` plus `config.auto_destroy: true`
  — "If true, the Machine destroys itself once it's complete."
- **Destroy**: `DELETE /v1/apps/{app_name}/machines/{machine_id}` (optional `?force=true`).
- **Auth**: `Authorization: Bearer ${FLY_API_TOKEN}`.
  (`https://fly.io/docs/machines/api/`, `https://fly.io/docs/machines/api/machines-resource/`)
- **Wall-clock limits**: none documented as an imposed ceiling — the machine runs until it exits or is
  force-stopped; billing is per-second while running.
- **Pricing**: per-second while running (`https://fly.io/docs/about/pricing/`) — e.g.
  shared-cpu-1x/256MB ≈ $0.0028/hr, performance-sized machines scale up from there; a **stopped or
  destroyed machine incurs no compute cost** — only a stopped (not destroyed) machine pays root-fs
  storage at $0.15/GB-month; a destroyed machine costs nothing further.
- **Egress control — documented, per-app/per-machine, deny-by-default once configured.** Fly's
  **Network Policies** API (`POST /v1/apps/{app}/network_policies`) is scoped finer than "whole org":
  policies apply per-app with selectors that can target `{"all": true}` (every machine in the app),
  specific machine IDs, or metadata — and **once any egress rule exists for an app, the default flips
  from open to deny-all** for that app, so an explicit allow-rule is required to reach anything
  (`https://fly.io/docs/machines/guides-examples/network-policies/`). This is a real per-run egress
  lever, not merely internal 6PN/WireGuard mesh networking (which is a separate, unrelated feature at
  `https://fly.io/docs/networking/private-networking/`).

**This is a real, working DIY option**: create a machine from a purpose-built image (Node 22 + git +
gh CLI + Claude Code CLI), inject the short-lived GitHub + Anthropic credentials as `config.env`, set
`auto_destroy: true`, attach a network policy scoping egress to exactly the hosts this task needs, and
have Alfred's own process poll `GET /v1/apps/{app}/machines/{id}/wait?state=stopped|destroyed`
(blocking wait with a timeout, default 60s) for completion — there is no push-webhook for machine
completion, so this shares Vercel Sandbox's "no callback" limitation, but Alfred owns the whole stack
(image, egress posture, credential lifetime) rather than trusting a third party's sandbox
implementation.

### Railway's own API — NO-GO for one-off jobs

- Railway's public GraphQL API documents managing projects/services/deployments/variables/environments/
  domains/volumes, and mutations for triggering deployments/rollbacks
  (`https://docs.railway.com/reference/public-api`) — but **no documented mutation creates a one-off,
  ephemeral job/container run** distinct from redeploying a persistent service.
- Railway **does** support "cron jobs" — but these are dashboard/settings-configured, schedule-driven
  **services** ("Services configured as cron jobs are expected to execute a task, and terminate as soon
  as that task is finished") with a minimum 5-minute interval between runs and no minute-level
  guarantee — **not an API-triggerable one-shot execution primitive**
  (`https://docs.railway.com/guides/cron-jobs`).
- **Closest workaround**: deploy the job as a normal (non-cron) service whose entrypoint exits when
  done, then trigger an on-demand run via the `serviceInstanceRedeploy(serviceId, environmentId)`
  GraphQL mutation — this redeploys the existing build without checking GitHub for new commits, i.e. a
  repurposed "redeploy an existing service" call standing in for a one-shot-job API, with no documented
  run-isolation or built-in kill-switch for a hang. Railway also **does not auto-terminate
  deployments**, so a stuck job silently blocks the next trigger rather than being killed
  (`https://docs.railway.com/cron-jobs`, `https://docs.railway.com/guides/manage-deployments`).
- Auth: Account / Workspace / Project tokens exist; rate limits are 100–10,000 requests/hour by plan —
  none of this changes the underlying gap. No per-service egress/network-policy control is documented;
  Railway only offers **Static Outbound IPs** (Pro plan) so a *third-party* firewall can allowlist
  Railway's IP — the reverse of restricting what the job itself can reach
  (`https://docs.railway.com/networking/static-outbound-ips`).

**Verdict:** Railway is not a fit for "spin up one ephemeral job from Alfred's own process, then tear it
down" — the closest primitive is redeploying an existing, persistently-defined service, which is a
different shape than a one-off run. If Alfred wants to stay entirely on infrastructure it already pays
for, Fly.io (or a self-hosted GitHub Actions runner, per §1) is the better DIY target; Railway is not.

### Single biggest risk of each
- **Fly.io Machines:** no completion webhook — purely poll-based (`/wait?state=...`) — and the
  egress-deny behavior only activates once Alfred explicitly attaches a network policy; forgetting that
  step leaves the machine on default-open egress.
- **Railway:** there is no one-off-job primitive to build on — this isn't a risk to mitigate, it's a
  capability gap that rules the option out for this use case; the `serviceInstanceRedeploy` workaround
  also has no documented egress control at all (only inbound-IP-allowlisting via Static Outbound IPs,
  which solves the opposite problem).

---

## 5. Headless coding-agent invocation — Claude Code CLI

(Checked against `code.claude.com/docs/en/headless`, `/docs/en/cli-reference`, and
`/docs/en/permission-modes` — all fetched 2026-07-25. Flag names below are current as of that date;
Claude Code's CLI surface changes across versions, and several behaviors below are explicitly
version-gated in the docs, noted inline.)

### Single non-interactive run

```
claude -p "Fix the bug described in this stack trace: ..." --output-format json
```
`-p` / `--print` is the flag; **`--bare`** additionally skips auto-discovery of hooks/skills/plugins/
MCP servers/auto-memory/CLAUDE.md for faster, more deterministic startup — "the recommended mode for
scripted and SDK calls, and will become the default for `-p` in a future release." In `--bare` mode,
Claude has Bash + file read/edit by default and auth must come from `ANTHROPIC_API_KEY` (bare mode
skips OAuth/keychain reads).
(`https://code.claude.com/docs/en/headless`)

### Constraining tool permissions without a human present

Permission modes (`https://code.claude.com/docs/en/permission-modes`):

| Mode | What runs unattended | Fit for this use case |
|---|---|---|
| `default` (aka `manual`) | Reads only | Too restrictive — nothing gets fixed |
| `acceptEdits` | Reads, file edits, common filesystem commands (`mkdir`/`touch`/`mv`/`cp`/`sed`) | Auto-approves edits but not arbitrary Bash/git — still needs `--allowedTools` for git/gh |
| `auto` | Everything, gated by a background classifier model | Reduces prompts but "in non-interactive mode ... repeated blocks abort the session since there is no user to prompt" — a real risk for a fully headless run |
| **`dontAsk`** | **Only pre-approved tools** (`permissions.allow` rules + built-in read-only commands) | **The documented fit for "locked-down CI and scripts"** — the session never waits for input; anything not pre-approved is silently denied rather than prompted |
| `bypassPermissions` | Everything, no checks | **"Only use this mode in isolated environments like containers, VMs, or dev containers without internet access"** — explicitly wrong for a network-enabled, credentialed run |

**Recommended combination for "edit files and run git/gh unattended in a throwaway container, nothing
else":**
```
--permission-mode dontAsk --allowedTools "Read,Edit,Write,Bash(git *),Bash(gh pr create *),Bash(npm *)"
```
`dontAsk` denies the built-in `AskUserQuestion` tool and any org-`ask`-marked connector/MCP tool even if
an allow rule matches — appropriate for a run with no human to answer a clarifying question.
`bypassPermissions` is explicitly the wrong mode here: it's designed for network-isolated sandboxes, and
Alfred's runner needs the opposite (network-open, but *tool*-scoped).

Note the flags-only picture is incomplete for containers: Claude Code also refuses to start in
`bypassPermissions` "when running as root or under `sudo`" unless inside "a recognized sandbox" — not
relevant to `dontAsk`, but worth knowing if a container image runs as root by default.

### Bounding and reporting cost

- **`--max-turns N`** (print-mode only): "Limit the number of agentic turns... Exits with an error"
  when exceeded — no default limit otherwise.
- **`--max-budget-usd N`** (print-mode only): "Maximum dollar amount to spend on API calls before
  stopping... Subagent spend counts toward cap."
- **`--output-format json`**: the response payload "includes `total_cost_usd` and a per-model cost
  breakdown" — a scripted caller reads this directly without consulting a separate usage dashboard.
  (`https://code.claude.com/docs/en/cli-reference`, `https://code.claude.com/docs/en/headless`)

### Retrieving the final diff / result

Two complementary paths, both documented:
1. **Read the working tree after exit** — the container's git checkout is mutated in place; the
   caller (or a subsequent step in the same job) runs `git diff` / `git status` against it. This is the
   implicit model behind every headless example GitHub's own docs show.
2. **Let Claude do it itself via tool calls** — the documented commit-creation example explicitly grants
   `Bash(git diff *)`, `Bash(git log *)`, `Bash(git status *)`, `Bash(git commit *)` so Claude stages and
   commits directly; the same pattern extends to `Bash(git push *)` and `Bash(gh pr create *)` for
   opening the PR itself inside the same non-interactive run, rather than a wrapper script doing it
   after the fact.
   (`https://code.claude.com/docs/en/headless` → "Create a commit" example)

### CLI vs. Agent SDK vs. Managed Agents — which is "the" recommended path

Per Anthropic's own docs: **the Agent SDK is Claude Code packaged as a library** — "gives you the same
tools, agent loop, and context management that power Claude Code," available as the CLI itself (what
this section covers), or as Python/TypeScript packages for "full programmatic control"
(`https://code.claude.com/docs/en/headless`). Both are **harness-only** — Alfred still owns the
container/deployment (this is exactly the substrate question sections 1–4 answer). **Claude Code
GitHub Actions is explicitly "built on top of the Claude Agent SDK"** — so option 1 (§1, GitHub Actions)
and this option are not actually alternatives; a real deployment likely composes them (`claude -p`
invoked from inside a `workflow_dispatch`-triggered Action). The one thing that supplies **both** harness
*and* managed deployment is **Managed Agents (CMA)** — covered as its own substrate in §6, since it
changes the trust-surface analysis materially enough to warrant separate treatment.

### Auth for a headless run

- `ANTHROPIC_API_KEY` env var — works everywhere, including `--bare` mode.
- `claude setup-token` — "Generate long-lived OAuth token for CI/scripts (prints to terminal, doesn't
  save)" — an alternative to a static API key for CI contexts, though the docs excerpt fetched here
  didn't detail the token's scope/lifetime beyond "long-lived"; treat that as a gap to verify before
  relying on it as the sole auth path.
  (`https://code.claude.com/docs/en/cli-reference`)

### Single biggest risk
**`--max-turns`/`--max-budget-usd` are advisory ceilings on one invocation, not a network/tool sandbox**
— nothing in the CLI itself stops an over-broad `--allowedTools` grant from letting a misbehaving or
prompt-injected run do more than intended. The permission-mode table is the actual control surface;
picking `dontAsk` + a narrow `--allowedTools` list is what does the containment work, not the cost/turn
flags (which only bound *how long* an already-scoped run can go wrong).

---

## 6. Claude Managed Agents (CMA) — the purpose-built option

Not one of the five substrates the prompt named, but worth surfacing on its own: Anthropic's own
`platform.claude.com` docs describe a product that is almost exactly this use case — **a hosted agent
loop with a per-session sandbox, a GitHub-repo resource with a scoped, egress-injected credential, and a
webhook-driven completion signal.** (`managed-agents-2026-04-01` beta; per the bundled `claude-api`
skill's live reference tables.)

### How Alfred triggers a run
`agents.create()` once (persisted, versioned config: model, system prompt, tools, MCP servers) →
`sessions.create({agent: AGENT_ID, environment_id: ENV_ID, resources: [...], initial_events: [...]})`
per task, from any Node process holding an Anthropic API key — no different in principle from calling
the Messages API today.

### Injecting a scoped credential — and NOT into the sandbox

A `github_repository` session resource clones exactly one repo into the container at session start:
```json
{"type": "github_repository", "url": "https://github.com/owner/repo",
 "authorization_token": "<fine-grained PAT, Contents R/W>", "checkout": {"type": "branch", "name": "main"}}
```
Critically: **"`authorization_token` is never placed inside the container... `git pull`/`git push` and
GitHub REST calls against the attached repository are routed through an Anthropic-side git proxy that
injects the token after the request leaves the sandbox. Code running in the container — including
anything the agent writes — cannot read or exfiltrate it."** This is a materially stronger containment
property than any of substrates 1–5: in a GitHub Actions job, a Fly Machine, or a raw Claude Code CLI
container, the token sits in an env var the process (and any code it runs) can read directly. To
**create the PR** (not just push a branch), the session also needs the GitHub **MCP server**
(`mcp_servers: [{"type": "url", "name": "github", "url": "https://api.githubcopilot.com/mcp/"}]`) with
its OAuth credential stored in a **vault** and attached via `vault_ids` — the `github_repository`
resource alone is filesystem/git access only.

### Network
The environment's `config.networking` is `"unrestricted"` (default — full egress except a legal
blocklist) or `"limited"` (deny-by-default, with `allow_package_managers`/`allow_mcp_servers`/
`allowed_hosts` opt-ins) — Alfred would run `unrestricted` (or `limited` + `allow_package_managers: true`
+ `allow_mcp_servers: true`) to get npm/PyPI/git/Anthropic-API access, which is exactly this use case's
stated requirement.

### Learning the run finished — webhook, not polling
Console-registered webhooks fire `session.status_idled` and `session.status_terminated` (HMAC-signed,
thin payload — event type + resource IDs; fetch the session for full state). This is the one substrate
in this whole survey with a genuine push-based completion signal that doesn't require a worker to hold a
connection open or poll — closer to GitHub's `workflow_run` webhook than to Vercel/E2B/Daytona/Modal/Fly's
synchronous-await-only model.

### Cost
Per-session usage accumulates in `span.model_request_end` events (`model_usage.input_tokens`/
`output_tokens`/cache fields) and is queryable via `sessions.retrieve().usage` — normal Anthropic API
billing, no separate compute meter (unlike Vercel/E2B/Daytona/Modal/Fly, which bill compute-seconds on
top of whatever LLM cost the CLI running inside them incurs).

### New trust surface this introduces
The task and its output now transit Anthropic's infrastructure as a first-class party (not just as the
model provider, as in substrates 1–5 where Anthropic only ever sees prompts/completions, never the
sandbox or the credential). The repo's source code is mounted into an Anthropic-operated container. For
Alfred's stated case — the user's *own* GitHub-hosted code plus a stack trace, with the explicit premise
that "third-party data custody is NOT the blocker here" — this is an acceptable trade given the
containment win on the credential (never touches the sandbox) and the completion webhook. It is a
**meaningfully different decision** than the isolate/Code-Mode case, where routing private Gmail/Drive
reads through a third party was the disqualifying factor.

### Single biggest risk
**Beta status** (`managed-agents-2026-04-01`) — the API surface (session resources, vault credential
shapes, webhook event set) is still versioned as beta and could change; and it is a genuinely new
operational dependency (Anthropic's session/environment uptime, not just Messages API uptime) that
Alfred doesn't currently have in its critical path.

---

## Recommendation for Alfred

**Ranking for this specific use case** (bounded SWE task from a stack trace → PR a human reviews):

1. **GitHub Actions (`workflow_dispatch` + App installation token) running the Claude Code CLI headless
   (`claude -p --permission-mode dontAsk`)** — the pragmatic default. Zero new infrastructure (Alfred
   already has the App + installation-token minting), zero new vendor dependency beyond Anthropic +
   GitHub (both already load-bearing), and GitHub's own container is the execution environment so there's
   no additional "whose sandbox is this" trust question. The Actions runner *is* the throwaway container.
2. **Claude Managed Agents**, once out of beta (or sooner, if the team is comfortable with a beta
   dependency) — the strongest containment story for the credential specifically (token never enters the
   sandbox) and the only substrate with a genuine completion webhook. Worth prototyping in parallel to #1,
   not instead of it, given the beta-surface risk.
3. **Fly.io Machines API** as the DIY fallback if either of the above proves too constrained (e.g. Actions'
   6-hour job cap, or wanting a custom base image with more tooling than a GitHub Actions runner offers
   pre-installed) — real one-off-job primitive, Bearer-token auth, no new vendor Alfred doesn't already
   plausibly want for infra reasons.
4. **Vercel Sandbox / E2B / Daytona** — viable but each adds a new vendor for marginal benefit over #1
   or #3. Vercel's firewall can broker the GitHub credential so it never enters the sandbox at all — the
   strongest non-CMA credential story of the group — but none of the three has a genuine completion
   webhook (Daytona has coarse state-change webhooks; Vercel and E2B are synchronous-await/poll). Daytona
   and E2B both document real domain/CIDR egress allowlisting if fine-grained network control becomes a
   requirement later; weigh Daytona's reported OSS-to-closed-source pivot before betting on its BYOC tier.
5. **Modal** — weakest fit here; no host-level egress restriction, no JS-native completion signal beyond
   polling, and its "Proxies" feature solves a different problem than Alfred needs.
6. **Railway's own API** — not viable for one-off jobs; no ephemeral-job primitive exists in the
   documented API surface.

**Containment invariants the winner (GitHub Actions, per #1) must be paired with, regardless of which
substrate is chosen:**
- **Branch-only push, never `main`/default branch directly** — enforce via the token's own scope
  (fine-grained PAT or App permission: Contents R/W is enough for a branch push + PR; do not grant
  Administration or the ability to push to protected branches) and via a repo branch-protection rule as
  a second layer.
- **One repo per run** — mint the token (App installation token or fine-grained PAT) scoped to exactly
  the repository the task concerns; never a token valid across the whole GitHub App installation or
  organization.
- **No Alfred DB/secret access from inside the runner** — the delegated job gets only the GitHub
  credential + Anthropic API key it needs for *this* task; it must not inherit Alfred's Postgres
  connection string, other integration tokens, or `serverEnv()` wholesale. Build the env injection as an
  explicit allow-list, not by forwarding Alfred's process environment into the job.
- **No auto-merge** — the job opens the PR and stops; merging is a human action. Do not grant the token
  `contents: write` in a way that also permits merge, and do not add an auto-merge tool/step to the
  agent's own capability set.

---

## Sources
- GitHub REST — workflow dispatch: `https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event`
- GitHub Actions — `workflow_dispatch`/`pull_request`/`workflow_run` events: `https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows`
- GitHub Actions — `GITHUB_TOKEN` permissions & auto-token auth: `https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication`
- GitHub Actions — triggering a workflow from a workflow (the recursion gotcha): `https://docs.github.com/en/actions/using-workflows/triggering-a-workflow`
- GitHub Actions — usage limits: `https://docs.github.com/en/actions/reference/limits`
- GitHub Actions — security hardening (self-hosted runners, JIT runners): `https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions`
- GitHub-hosted runners — IP ranges / larger-runner static IPs: `https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners/about-github-hosted-runners`
- GitHub Actions billing/pricing: `https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions`
- Claude Code GitHub Actions: `https://code.claude.com/docs/en/github-actions`, `https://github.com/anthropics/claude-code-action`
- Claude Code headless mode: `https://code.claude.com/docs/en/headless`
- Claude Code CLI reference: `https://code.claude.com/docs/en/cli-reference`
- Claude Code permission modes: `https://code.claude.com/docs/en/permission-modes`
- Vercel Sandbox: `https://vercel.com/docs/sandbox`, `/docs/sandbox/concepts`, `/docs/sandbox/concepts/authentication`, `/docs/sandbox/concepts/firewall`, `/docs/sandbox/pricing`, `/docs/sandbox/sdk-reference`
- E2B: `https://e2b.dev/docs`, `https://e2b.dev/docs/sandbox/internet-access`, `https://e2b.dev/pricing`, `https://e2b.dev/docs/quickstart/connect-llms`
- Daytona: `https://www.daytona.io/docs`, `/docs/en/network-limits`, `/docs/en/webhooks`, `/docs/en/billing`, `/docs/en/bring-your-own-compute`, `https://www.daytona.io/pricing`
- Modal: `https://modal.com/docs/guide/sandbox`, `/docs/guide/webhooks`, `/docs/guide/proxy-ips`, `https://modal.com/pricing`
- Fly.io Machines API: `https://fly.io/docs/machines/api/`, `/docs/machines/api/machines-resource/`, `/docs/machines/guides-examples/network-policies/`, `https://fly.io/docs/about/pricing/`, `https://fly.io/docs/networking/private-networking/`
- Railway public API, cron jobs, deployments, networking: `https://docs.railway.com/reference/public-api`, `https://docs.railway.com/guides/cron-jobs`, `https://docs.railway.com/guides/manage-deployments`, `https://docs.railway.com/networking/static-outbound-ips`
- Anthropic Managed Agents (via bundled `claude-api` skill, sourced from `platform.claude.com/docs/en/managed-agents/*`): core, environments, tools (vaults, MCP), events/webhooks, API reference
- Alfred's own GitHub App installation-token minting: `packages/integrations/src/github/app.ts` (`getInstallationToken`, line 102)
