# Composable automation substrate v1 — kernel, workspace, execution ladder

**Status:** PRD / design draft · **Date:** 2026-07-25
**Decision record:** proposes **ADR-0089**. Widens **ADR-0087**'s scope (isolate = one rung of a ladder, not context-virtualization-only), fills in **ADR-0074** rung-(b) framing, and extends **ADR-0017/0025** (workflows), **ADR-0047** (event bus), **ADR-0043** (integration write ceiling), **ADR-0069** (high-risk approval floor), **ADR-0073** (child-completion wake join).
**Research:** [delegated agent runner substrates](../research/delegated-agent-runner-substrates.md), [Sentry push surface & autofix](../research/sentry-push-surface-and-autofix.md), [code-mode sandbox feasibility](../research/code-mode-sandbox-feasibility.md), [compiled browser flows tightening](../research/compiled-browser-flows-v1-tightening.md), [trace → workflow generation](../research/trace-to-workflow-generation.md), [workflows v1 synthesis](../research/workflows-v1-research-synthesis.md), [integration/event lifecycle](../research/workflows-v1-integration-event-lifecycle.md).
**Depends on:** [workflows-v1](./workflows-v1.md) (the durable spine). **Epic:** needs a GitHub issue.

---

## Problem Statement

Alfred can run unattended work, but it cannot be *extended* unattended. Three specific ceilings:

1. **Nothing outside a hardcoded list can wake it.** `EVENT_SOURCES` in `packages/contracts/src/event-triggers.ts` is a three-value enum (`gmail`, `google.oauth.callback`, `learn-skill`). Every new push source is a code change in three places, so "expose a webhook and react to it" is not a capability the product has.
2. **Work cannot accumulate.** There is no durable place for an agent to put a file that a later step, a later run, or a different execution environment can read. Artifacts are a presentation surface, not a workspace.
3. **Execution is one shape.** Everything is a tool call in the API process. There is no rung for "run this program", "drive this browser", or "make this code change" — so any capability needing network, a credential, or a real filesystem has no home.

The goal is not a bigger tool list. It is that a bounded external event can reach a revisioned program, that the program can run at the lowest execution rung that does the job, and that everything it touched is attributable and reviewable afterward.

## The frame

Borrowed from Cloudflare's Project Think and the `agent-os`/Sauna lineage, because the vocabulary is
better than ours: **the kernel owns durable state, and everything an agent does is a syscall against
it.** Programs run with **no ambient authority** — they start with nothing and receive explicitly
granted capabilities. Above the kernel sits an **execution ladder**, and you pick the lowest rung that
does the job.

Most of that already describes Alfred, which is the useful finding:

| Primitive | Alfred today |
| --- | --- |
| Durable execution, checkpoint-before-execute, crash recovery | **Have it.** `Workflow<S>` named steps, BullMQ, Postgres checkpoints, recovery sweep, ADR-0070 non-progressing-step backstop |
| Sub-agents with typed join | **Have the join** (ADR-0073 child-completion wake). Per-child isolated storage is not load-bearing at n=1 |
| Persistent sessions + compaction | **Have it** (#223 compactor and cache-breakpoint discipline). Tree-forking is chat UX, not substrate |
| Capability-scoped code execution, no ambient authority | **ADR-0087 is this design**, derived independently. Scoped to one job |
| Syscall table with authorization | **Ahead.** The dispatcher authorizes against risk tiers, an approval floor, an exact `allowed_tools` envelope, and a user model. A bare kernel grants capabilities; ours grants them against who the user is and what they approved |
| Program promotion / revisioning | **Ahead, on paper.** `workflows-v1.md` specifies draft child revision → fixture eval → compare-and-swap promotion → rollback. Think's self-authored extensions have no equivalent |
| Execution ladder | **Missing, including its bottom rung** |
| Hibernate-to-zero economics | **Not applicable.** That is a multi-tenant argument. Alfred is n=1 and 96% of spend is Anthropic |

So this plan adds the ladder and its bottom rung. It does not rebuild the kernel; it renames what is
already there and gives it somewhere to dispatch.

Terminology, fixed for the rest of this document: **occurrence identity = process identity**, **logical
effect identity = syscall identity**, **pinned workflow revision = program identity**. These are
existing `workflows-v1.md` concepts, not new ones.

## Product Decision

Ship three things in dependency order, on top of the `workflows-v1.md` spine:

1. **An ingress registry.** One typed source-descriptor registry behind one inbound webhook route. Any
   push source becomes a descriptor, not a code change in the contracts enum.
2. **A workspace.** A durable, path-addressed, per-user filesystem that is the ladder's data bus. Every
   rung materializes a scoped subtree in and reconciles a diff out.
3. **An execution ladder.** Rungs are interchangeable providers behind one typed effect. Adding a rung
   does not change the workflow contract.

Nothing here requires a terminal, a Cloudflare migration, agent-authored webhook handlers, a generic
integration mirror, or Code Mode as a prerequisite.

### Forks decided

1. **Workspace is internal plumbing, not a user surface.** No terminal, no file browser. Chat and the
   artifact sidebar address the workspace; the user never navigates it. Building a terminal would decide
   that Alfred is also an agent workstation, which is a different product from a personal assistant.
   Decided against, deliberately.
2. **Two substrates, split by callback need, not by custody.** See [Substrate split](#substrate-split).
   A program that must call back into the kernel runs in-process on Railway. A program that needs
   network, a credential, and a filesystem runs in a remote microVM (Vercel Sandbox).
3. **No Cloudflare.** Not deferred — rejected on mechanism. See [Why not Cloudflare](#why-not-cloudflare).
4. **Ingress is a curated registry, not user-registered endpoints.** Descriptors are code-resident and
   reviewed. The registry removes the enum ceiling; it does not remove the security ceiling. This
   mirrors the `workflows-v1.md` argument that the authorable trigger subset stays curated.
5. **Sentry is descriptor #1, not the design driver.** The loop is generic. Sentry is a worked example
   because it is a source Alfred already emits to — and, usefully, an example that fails the
   build-vs-buy test in an instructive way. Per the
   [Sentry research](../research/sentry-push-surface-and-autofix.md), **Seer already ships
   "error → PR" end to end**: GA, auto-triggered on an ML fixability score, opening real PRs, and
   emitting a `seer.pr_created` webhook carrying the PR URL. So Alfred should not write that fix. The
   composable play inverts: **consume `seer.pr_created` as an ingress descriptor and spend rung B on
   verifying the resulting preview**, which is the part nobody sells. What cannot be bought is deciding
   which errors are worth fixing at all, and that judgment belongs in Alfred's user model, not in a
   coding agent.
6. **Code Mode stays off the critical path.** ADR-0087's rung-(a) truncation thermometer has not fired.
   The isolate is built here for a *second* driver (it is a ladder rung), which is what justifies
   building it now; the context-virtualization gate is unchanged.
7. **No agent-authored webhook verifiers.** Thirty lines each, one per source, has to be right. Authored
   code earns its keep on the long tail the user will not specify twice (bulk mutations, one-off
   reshapes, glue between two integrations), not on the trust boundary.

## Substrate split

The ladder splits on one mechanical question: **does the program need to call synchronously back into
the kernel while it runs?**

| Rung | Job | Network | Credentials | Data entering it | Callback to kernel | Substrate |
| --- | --- | --- | --- | --- | --- | --- |
| **0 · workspace** | read/write durable files | n/a | n/a | whatever the run put there | n/a | Postgres metadata + R2 content |
| **A · isolate** | compute over parked handles and workspace files | **none** | **none** | the user's private reads | **required** (`load`, `broker.read`) | in-process `isolated-vm@6.1.2` in a `--no-node-snapshot` forked worker |
| **B · browser** | see and act on pages | origin-allowlisted | none (logged out v1) | public page content | not needed | Vercel Sandbox |
| **C · coding agent** | change one repo | broad (git, registries, Anthropic) | one repo, branch+PR only | the user's own source + a trace | not needed | Vercel Sandbox |

Rung A **cannot** move to a remote sandbox. Vercel Sandbox has no host-callback channel; data flows in
via `writeFiles`/args and out via `stdout`/`readFile`. Implementing `load(handle)` there means either
shipping all the private data in at creation or exposing a public broker endpoint and putting a bearer
token inside untrusted code — the exact shape ADR-0087 rejected. `applySyncPromise` in a local isolate
is the primitive that design needs, and it only exists in-process.

Rungs B and C have no callback need. They receive a workspace subtree and a task, and they emit
artifacts and a diff. A remote Firecracker microVM is strictly better isolation than a V8 isolate for
those, and the custody objection does not apply: rung B sees public pages, rung C sees source that
already lives on GitHub plus a trace that already lives at the error tracker.

This is not a compromise between two options. It is what the callback requirement forces.

### Why not Cloudflare

Worker Loader is the one primitive Railway genuinely cannot provide: isolate-per-program with
capability-scoped bindings and real module resolution, at near-zero marginal cost. It still loses here,
for reasons that are about mechanism rather than taste.

- **Its value requires co-location.** The point of capability bindings is that they bind to a durable
  store *next to the isolate*. Alfred's durable store is Postgres on Railway. A CF isolate reaching it
  is a network hop plus a token shipped into the isolate — which is worse than a local isolate on
  custody and no better on capability. A satellite program plane therefore does not work; only moving
  the kernel does, and that is migration.
- **Migration is already rejected**, and the reasons still hold: no native pgvector Postgres, BullMQ's
  persistent-polling process shape against eight queues, the 24/7 tick, plus a pg→HTTP driver swap and
  native-dependency replacement. That evaluation was about cost; the process-shape argument is the
  durable half.
- **The economics do not apply.** Zero marginal cost per isolate is a 10,000-agents argument. At n=1
  with dozens of runs a day, Vercel Sandbox's metered creations and CPU-hours are rounding error.
- **Custody is not the blocker either way** — Cloudflare is already in the trust set, since chat uploads
  live in R2 (`CHAT_S3_*`, ADR-0065). This is worth stating so the rejection is not mistaken for a trust
  judgment that would also implicate R2.

Correction to an earlier suggestion in this design's discussion: a "CF satellite program plane" was
floated as a way to get Worker Loader without migrating. It does not survive the co-location argument
above. Recorded so it is not re-proposed.

Also relevant: **Railway has no ephemeral-job primitive** in its public API, so the top of the ladder
was always going to leave the box. The only question was which off-box substrate, not whether.

## Seam 1 — ingress registry

Replace the `EVENT_SOURCES` enum with a code-resident registry of source descriptors behind one route:

```
POST /webhooks/inbound/:source
```

A descriptor owns exactly the provider-specific knowledge and nothing else:

```ts
interface InboundSourceDescriptor {
  slug: string;                                    // registry key, curated
  verify(raw: string, headers: Headers): VerifyResult;   // timing-safe, over RAW bytes
  deliveryId(raw: string, headers: Headers): string | null;
  eventTypes: readonly string[];                   // what a workflow may subscribe to
  project(payload: unknown): NormalizedEvent;      // typed projection, never a cast
  subscription?: SubscriptionAdapter;              // provision / renew / verify, where the provider has one
  cursor?: CursorAdapter;                          // provider-native recovery, where one exists
}
```

`github-webhook.ts` is already this pattern by hand: raw-body HMAC over `X-Hub-Signature-256`, then
`on conflict do nothing` into `webhook_events` keyed on `X-GitHub-Delivery`. The work is generalizing
it, not inventing it. The subscription / receipt / cursor primitives are already specified in the
[integration event lifecycle research](../research/workflows-v1-integration-event-lifecycle.md) §319–367
and are adopted here unchanged, including its rule that cursor *interpretation* stays in provider code.

Rules:

- Verification is on raw bytes, before parse, timing-safe. Non-negotiable per the `@alfred/integrations`
  boundary.
- A descriptor with no stable delivery ID must declare a synthetic dedup key explicitly; it may not
  silently fall back to "probably unique". **This is the common case, not the exception.** GitHub's
  `X-GitHub-Delivery` is stable across redeliveries; Sentry's `Request-ID` is `uuid4()` minted fresh
  inside each retry, so it is unusable as an idempotency key and its descriptor must dedup on payload
  identity (`event_id`, or `issue.id` + `action`). Hence `deliveryId()` returns `string | null` and the
  synthetic key is a first-class part of the descriptor rather than a fallback.
- Ingress acknowledges fast and enqueues. It never runs an interpreted workflow inline. This has teeth:
  Sentry retries only on network failure (3× / 5 min apart) and **auto-unsubscribes a webhook after
  1000 timeouts in 24h**, so a slow handler does not degrade delivery, it ends it.
- A source with no healthy subscription reports `trigger_degraded`. Absence of deliveries never renders
  as a confident "nothing happened".
- The registry is the authorable trigger surface's *ceiling*, not its definition. Which descriptors a
  user may subscribe a workflow to remains a curated subset.

**Non-obvious consequence:** rung B and rung C completion notices arrive as inbound webhooks too. Of
every substrate researched, only Anthropic's Managed Agents (beta) has a genuine completion push; the
rest are poll-or-hold. So seam 1 gates seam 2 structurally — a delegated run cannot report home without
an ingress descriptor to report into. Build order follows from that, not from preference.

## Seam 0 — workspace

The ladder's data bus. Path-addressed, per-user, durable, with metadata in Postgres and content in R2
(the store already in use for chat uploads).

- **Addressing:** `/{userId}/{scope}/{path}`, where `scope` is a run, a workflow, or a long-lived
  project. Capability grants are subtree-scoped, so a program receives `/ws/run-123/**` and cannot name
  anything above it.
- **Versioning:** content-addressed blobs with a per-path version. A rung reconciling a diff back does
  it against the version it materialized, and a mismatch is a typed conflict, not a last-write-win.
- **Materialize / reconcile:** a rung receives a scoped subtree on start (`writeFiles` for a remote
  sandbox, a host function for the local isolate) and returns a diff on completion. One writer per
  subtree per run.
- **Bounds:** per-scope byte and file-count caps, TTL per scope class, and explicit retention for
  anything a human may want to read later.
- **Reuse:** rung B writes screenshots and traces here, so the artifact sidebar renders them with no new
  transport. Rung A's parked handles become workspace-adjacent objects rather than a second store.

The workspace is why the rungs compose. Without it, every rung needs a private data path to every other
rung, which is what made the delegated-run effect feel heavy when it was first sketched.

## Seam 2 — rung dispatch

One typed effect, with the rung as a parameter rather than a bespoke feature per substrate:

```ts
interface DelegatedRun {
  rung: "isolate" | "browser" | "coding_agent";
  brief: string | CompiledProgram;      // interpreted brief, or a pinned program artifact
  grants: {
    workspace: WorkspaceSubtreeGrant[];
    handles?: HandleRef[];              // rung A only
    reads?: BrokerReadScope[];          // rung A only
    credential?: ScopedCredentialGrant; // rung C only, minted per run
    origins?: string[];                 // rung B only, enforced by the sandbox firewall
  };
  limits: { wallClockMs: number; costUsd?: number; turns?: number; bytesOut: number };
  completion: { descriptor: string; deliveryKey: string };   // ingress descriptor to report into
}
```

It reuses, and does not reinvent: the ADR-0073 child-completion wake signal for the durable await, the
`workflows-v1.md` logical effect ledger for identity and `unknown` outcomes, and the ADR-0069 approval
floor for anything the run proposes to change externally.

Every rung returns the same shape: typed outcome, evidence bundle pointer, workspace diff, resource
counters. A rung that cannot prove what it did returns `unknown`, never an empty success. Per the
[browser flows tightening](../research/compiled-browser-flows-v1-tightening.md), an ambiguous external
effect is not the same failure as drift, and only true drift may enter repair.

### Rung C specifics

**What rung C is for, stated narrowly.** Vendor-specific autofix already exists where the vendor owns
both the error and the repo link (Seer being the worked case). Rung C earns its place on the work no
vendor is positioned to do: a change spanning two systems neither vendor sees, a task originating from
somewhere with no coding agent attached, or one that depends on the user's own standing instructions and
history. Building it as a generic rung rather than a Sentry feature is what makes that true. If the
first use case turns out to be one a vendor already sells, consume the vendor and spend the ladder on
verification instead.

Substrate ranking, cost, egress, and secret semantics are in the
[runner substrates research](../research/delegated-agent-runner-substrates.md). What this plan fixes:

- **Push and PR with the App installation token, never the runner's default token.** A PR opened by a
  job's default `GITHUB_TOKEN` does not trigger further workflows, so the repo's own CI and preview
  deploy never fire. Any "fix → PR → verify the preview" loop dead-ends silently without this.
- **`getInstallationToken` needs per-repo narrowing before a runner ever holds a token.**
  `packages/integrations/src/github/app.ts:102` posts to `/app/installations/{id}/access_tokens` with no
  body, so the minted token spans the whole installation. That is fine while only Alfred's server holds
  it; it is not fine when it is handed to a delegated run. New code path, small, and a hard prerequisite.
- **Prompt injection is the live threat, and the isolate's guarantees do nothing for it.** An error
  message is attacker-controlled text; the path `payload → brief → credentialed agent → repo write` is
  real. Containment is structural, per the research file's closing invariants: branch-only push and never
  the default branch, one repo per minted token, an explicit env allow-list rather than forwarding
  Alfred's process environment, no auto-merge, and the PR as the review boundary.
- **Secrets and same-repo branches.** A same-repo branch gets full repository secrets in Actions, unlike
  a fork. If a runner ever executes repo-defined workflows on agent-authored branches, that is an
  escalation path and must be handled explicitly.

### Rung B specifics

Adopt the [tightening doc](../research/compiled-browser-flows-v1-tightening.md) as the rung's contract,
in particular: one browser API (Playwright-native), an engine pin in every program revision, per-node
effect classes with `read_only | browser_local | external_effect` and matching retry semantics, a typed
ordered locator plan instead of a "fat selector bundle", the failure taxonomy that keeps infrastructure
and policy denials out of locator repair, `persistent: false` with an immutable reviewed base snapshot,
and deny-by-default egress from the flow's own `allowedOrigins`.

First job is **read-only verification of the user's own properties** — screenshot a preview URL, assert
it rendered. That sidesteps the first-fixture problem entirely (no third-party terms, no login, no
scraping) and gives the rung an honest use before any compiled-flow interpreter exists.

## Non-Goals

- A terminal, a file-browser UI, or any user-facing workspace surface.
- Migrating to Cloudflare, or a CF satellite execution plane.
- Agent-authored webhook verifiers, schemas, or persistent handlers (the `self-syncing-agent` shape).
- A universal integration mirror or speculative embeddings — unchanged from `workflows-v1.md`.
- Widening ADR-0087's containment charter. Rung A keeps zero network and zero credentials; the rungs
  that need those are separate rungs with their own substrate.
- Making Code Mode a prerequisite for anything in this plan.
- Auto-merge, auto-activation, or any rung outcome that changes the world without the existing approval
  floor.

## Build order

Each step ends at something demonstrable, and each gates the next.

0. **`workflows-v1.md` spine.** Revision pinning, durable occurrence identity, logical effect identity
   with a real `unknown`, async readiness guard, cancellation fencing, typed outcomes, honest History.
   Gates everything. Unattended plus credentialed plus external-effect is exactly where these stop being
   hygiene.
1. **Ingress registry** + first descriptor. Ends at: an external push creates a durable receipt and
   exactly one run, redeliveries create none, and a degraded subscription reports as degraded. No
   executor risk yet.
2. **Workspace.** Ends at: a run writes files, a later run in the same scope reads them, a subtree
   materializes into a sandbox and reconciles back with version conflicts detected.
3. **Rung C.** Ends at: a bounded task produces a branch and a PR in one repo, opened by the App token
   so CI fires, with the per-run narrowed credential and every containment invariant enforced. Merging
   stays human.
4. **Rung B, read-only.** Ends at: a preview URL is screenshotted and asserted, evidence lands in the
   workspace, and the result posts back through the ingress descriptor.
5. **Rung A.** Ends at: a program computes over a parked handle and workspace files with forced
   provenance. Gated on ADR-0087's thermometer for the *context-virtualization* claim; buildable earlier
   as a ladder rung.
6. **Promotion.** Compiled programs via draft child revision → fixture eval → compare-and-swap, per
   `workflows-v1.md`. Gated on volume and low trajectory entropy. Try trace *retrieval* first — the
   [generation research](../research/trace-to-workflow-generation.md) found the measured prize of
   compilation is fewer turns rather than determinism, and that putting the last successful trajectory in
   front of the interpreted brief is the cheapest well-evidenced win and a rung the ladder is missing.

## Open verification

- Confirm Alfred's GitHub App has **Actions: write**, if `workflow_dispatch` is ever the rung-C trigger.
  The App's permission set is not recorded anywhere in the repo and must be checked against the live
  installation.
- Confirm `/app/installations/{id}/access_tokens` accepts the `repositories` narrowing as used, and that
  a narrowed token can push a branch and open a PR but nothing else.
- Confirm `isolated-vm@6.1.2` `applySyncPromise` against a real paged R2 read plus vendor I/O in the
  trusted parent, and pick isolate memory/timeout caps empirically. Keep `quickjs-emscripten` as the
  sanctioned pivot if the native build churns.
- Benchmark the four Vercel Sandbox startup phases separately (create/restore, browser launch, first
  Playwright connection, first page ready). "Starts in milliseconds" measures only the first.
- Measure per-run active CPU, provisioned-memory wall time, outbound bytes, and creation count. Express
  cost as a measured budget, never as an architectural claim.
- Decide whether rung C's completion signal is a poll-with-held-worker or a real webhook. Only one
  researched substrate offers the latter, and it is in beta.

## Test plan sketch

- **Ingress:** duplicate deliveries create one receipt and one run; a bad signature is rejected before
  parse; a descriptor with no delivery ID uses its declared synthetic key; a degraded subscription
  surfaces `trigger_degraded` rather than zero matching events.
- **Workspace:** subtree grants cannot name a path above their root; a stale-version reconcile is a typed
  conflict; scope TTL and byte caps are enforced; two concurrent writers to one subtree are rejected.
- **Rung dispatch:** a crash between "sandbox accepted the task" and "local effect committed" yields
  `unknown`, never a blind re-run; cancellation fences a later rung dispatch; a rung requesting a
  capability outside its grant returns a typed mismatch with no silent widening.
- **Rung C containment:** the minted token cannot push to the default branch, cannot reach a second
  repo, and carries no Alfred environment; a PR is never auto-merged; the PR triggers the repo's CI.
- **Rung B:** the sandbox firewall denies an off-allowlist origin including via redirect and popup;
  infrastructure and policy failures do not enter locator repair; an empty extraction is a typed outcome.
- **Injection:** a payload carrying instruction-shaped text does not widen any grant, change the target
  repo, or escape the approval floor.

## Remaining decisions

1. **Rung-C substrate.** Vercel Sandbox is the working assumption. GitHub Actions plus headless
   `claude -p` is the zero-new-infra alternative and needs no new vendor; Managed Agents has the
   strongest credential story and the only real completion webhook but is beta. Pick on the completion
   signal, since that is what the seam actually consumes.
2. **Channel reach.** "A top-notch cloud experience" is mostly reach, proactivity, and trust rather than
   substrate. Alfred is already cloud-resident and already proactive, and its trust model is the direct
   answer to a gateway that runs on your own machine with shell and filesystem authority. The gap is
   reach: today Alfred is a web app. Whether messaging channels are in scope is a product decision this
   plan does not need and does not make.
3. **Workspace retention.** How long a project-scoped subtree lives, and whether anything in it is ever
   surfaced to the user directly, given fork 1.
