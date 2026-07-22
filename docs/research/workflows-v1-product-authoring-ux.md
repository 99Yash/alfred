# User-authored workflows v1: product and authoring UX research

Status: researched 2026-07-22  
Scope: natural-language authoring, trigger resolution, connection readiness,
draft/active lifecycle, testing, inferred-capability approval, and run recovery.
This note evaluates the product direction in
[`workflows-v1.md`](../plans/workflows-v1.md); it does not specify implementation.

## Executive conclusion

The plan has the right entry point—chat proposes a workflow and the user reviews
it—but it collapses three materially different moments into one approval:
**save the idea, validate that it can work, and start running it**. Strong
automation products separate these moments.

The most consequential recommended changes are:

1. **Persist a blocked draft when a connection is missing; block activation, not
   saving.** The current “nothing persists” hard gate loses the user's authored
   intent and makes connection setup a dead end instead of a resumable step.
2. **Resolve every trigger to a concrete, editable contract before activation.**
   Show the timezone, recurrence/event semantics, and next expected run—not just
   a friendly paraphrase or raw cron.
3. **Make `draft → publish/activate` explicit.** The activation review should show
   the exact trigger, interpreted brief, integration accounts, capabilities, and
   remaining readiness problems. Approval to create a draft is not approval to
   begin unattended execution.
4. **Do not call a live execution a dry run.** Offer a side-effect-free preview
   of Alfred's interpretation, then a clearly labelled test run that says which
   external actions may occur. A successful full test should not be universally
   mandatory, because some event workflows cannot be meaningfully exercised at
   author time.
5. **Treat recovery as part of the core feature.** A workflow run needs
   step/outcome detail, the version and trigger input used, a reason-specific
   blocked/failed state, and a safe recovery action. Reconnecting an account
   should enable a user to resume or replay held work rather than merely fix
   future runs.

These changes do not require a DAG editor, sandbox, sync engine, or compiled
workflow runtime. They are lifecycle and truthfulness improvements around the
interpreted brief executor already selected for v1.

## What first-party products establish

| Product                        | First-party behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Product lesson for Alfred                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zapier Copilot                 | A plain-language request produces an outline; Copilot can build automatically or ask for confirmation before each suggestion, summarizes what it changed, exposes reasoning, and tells the user what it could not complete. It chooses an existing account by documented heuristics and prompts for a connection when none is available. The user separately publishes when finished. ([Zapier Copilot](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows))                                                                                                                                                                                                         | Natural language should produce an inspectable proposal, not an opaque active workflow. Inferred steps, values, and account choice need review and correction.      |
| n8n AI Workflow Builder        | The builder creates, refines, and debugs workflows from natural-language goals, gives progress feedback, and then asks the user to review required credentials and other parameters. ([n8n AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder/))                                                                                                                                                                                                                                                                                                                                                                                                                              | Generation is one phase of authoring. Credential and parameter readiness remain explicit after generation.                                                          |
| Zapier and n8n lifecycle       | New Zaps begin as auto-saved drafts and publishing turns them on; later edits can remain in a draft while the current version stays on. ([Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions)) n8n likewise auto-saves edits as drafts and keeps production pinned to the published version until another publish. ([n8n save and publish](https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows/))                                                                                                                                                                                                                                  | Saved intent and production behavior should not be the same state. Editing should not silently mutate the version currently running.                                |
| Zapier, n8n, and Apple testing | Zapier supports trigger, action, and end-to-end tests but explicitly warns that action tests are live and may change connected apps; only some structural steps are mandatory to test before publish. ([Zapier test steps](https://help.zapier.com/hc/en-us/articles/18811411817741-Test-Zap-steps)) n8n distinguishes ad-hoc manual tests from published production executions and supports pinned data and partial execution. ([n8n execution types](https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions/)) Apple puts a test control before a final automation summary. ([Apple create a personal automation](https://support.apple.com/en-ie/guide/shortcuts/apdfbdbd7123/ios)) | Test semantics must disclose side effects. A preview, validation, partial test, and live end-to-end test are distinct operations.                                   |
| Run history and recovery       | Zapier records run and per-step status, timestamps, data in/out, and workflow version, and can replay unsuccessful runs. ([Zapier run history](https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history)) n8n filters executions by state, retries with either the original or currently saved workflow, and can load prior failed input into the editor. ([n8n executions](https://docs.n8n.io/workflows/executions/all-executions/), [n8n debug executions](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions/))                                                                                                                                   | “Fired / produced / skipped” is a good start but not enough for diagnosis or safe recovery. Preserve input and version identity, and make retry semantics explicit. |
| Connection failure at runtime  | Zapier marks a run held when an app is disconnected, tells the user to reconnect, and then replay the held run. ([Zapier held runs](https://help.zapier.com/hc/en-us/articles/37454233721869-How-to-troubleshoot-held-Zap-or-step-runs)) IFTTT exposes service offline/online events and says it may eventually disable the service and associated Applets if reconnection does not happen; it does not disable merely because of one or two failures. ([IFTTT Activity feed](https://help.ifttt.com/hc/en-us/articles/115004914234-How-to-use-the-IFTTT-Activity-feed), [IFTTT automatic disabling](https://help.ifttt.com/hc/en-us/articles/360014195734-Why-do-Applets-and-connections-get-disabled))                 | Do not run with missing capabilities, but distinguish a held run from a paused workflow and a transient provider failure from revoked authorization.                |

## Findings and implications by product question

### 1. Natural-language authoring should be proposal-first and conversational

**Sourced fact.** Zapier Copilot accepts a “when X, do Y, then Z” description,
creates a basic trigger/action outline, and lets the user refine it in chat. It
offers both an auto-build mode and an “ask as you build” mode in which every
suggestion waits for confirmation; it also summarizes changes and exposes an
optional reasoning view. ([Zapier Copilot](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows))
n8n similarly frames natural-language generation as create, refine, and debug,
followed by review of credentials and parameters rather than immediate
activation. ([n8n AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder/))

**Recommendation for Alfred.** Keep the chat tool, but have it produce a durable
`Workflow proposal` with:

- what Alfred understood;
- the concrete trigger;
- an ordered, human-readable capability/intent outline even when execution
  remains brief-interpreted;
- the selected integration account for each capability;
- assumptions and unresolved questions; and
- `Edit`, `Preview`, and `Activate` actions.

The outline need not become a declarative DAG. It is an explanation contract for
an interpreted brief. The user should be able to correct one inferred field
without rephrasing the whole request.

For low-ambiguity requests, Alfred can fill the proposal automatically. Reserve
blocking questions for ambiguity that changes effects: destination channel,
which of multiple accounts, whether “morning” means a known preferred time, or
whether an action is send versus draft. This preserves the speed of chat without
making inferred operational details invisible.

### 2. Resolve natural-language triggers to exact, editable semantics

**Sourced fact.** Apple exposes time automation as structured choices: a
specific time or sunrise/sunset, an optional offset, and daily/weekly/monthly
repeat options. ([Apple event triggers](https://support.apple.com/guide/shortcuts/event-triggers-apd932ff833f/ios))
Zapier's Schedule trigger similarly exposes interval choices, while its account
timezone is used to interpret times and defaults to UTC if unset.
([Zapier scheduling](https://help.zapier.com/hc/en-us/articles/8495924437005-Control-when-your-Zap-runs),
[Zapier timezone](https://help.zapier.com/hc/en-us/articles/8496294243981-Manage-your-Zapier-account-profile))
Zapier also documents that trigger delivery can be polling or instant and that
the provider integration fixes which mode applies. ([Zapier trigger types](https://help.zapier.com/hc/en-us/articles/8496244568589-How-Zap-triggers-work))

**Recommendation for Alfred.** The approval card should never stop at “every
morning” or show only a cron expression. Resolve and display:

```text
Every weekday at 8:00 AM Asia/Kolkata
Next run: Thu, 23 Jul at 8:00 AM
Runs across daylight-saving changes in this timezone
```

For event triggers, display the provider, exact event, selected account/mailbox,
filter, and delivery expectation where known. If “morning” is not already a
trusted user preference, ask or present an editable default before activation.
Store structured trigger semantics plus timezone; treat the friendly label and
next-run preview as derived views.

This supports the plan's recommendation to resolve concretely, but the next-run
preview and account identity should become acceptance criteria, not polish.

### 3. Missing connections should block activation, not persistence

**Sourced fact.** Zapier requires app connections to create operational
workflows. Its Copilot selects a connection when one exists and prompts the user
to connect when none does. ([Zapier app connections](https://help.zapier.com/hc/en-us/articles/36818633398157-App-connections-on-Zapier),
[Zapier Copilot](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows))
Zapier drafts are auto-saved, and publishing may be unavailable while a step
needs attention. ([Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions))
n8n's generated workflow likewise survives as something the user reviews and
refines while required credentials and parameters remain visible.
([n8n AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder/))

**Recommendation for Alfred.** Replace the plan's author-time rule
“unsatisfied ⇒ nothing persists” with:

```text
author request
  → saved draft
  → readiness resolution
      → needs connection / reauth / account choice / unsupported capability
      → ready to test or activate
  → explicit activation
```

A blocked draft should keep the name, original request, interpreted brief,
resolved trigger, requested capabilities, and missing-reason list. Its card
should include a direct `Connect Slack`/`Reconnect Gmail` action and resume the
same draft after OAuth. This avoids forcing the user to reconstruct intent after
leaving chat.

Different failure reasons need different copy and affordances:

| Readiness reason          | User-facing posture                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `not_connected`           | “Connect Gmail to finish this workflow.”                                                     |
| `needs_reauth`            | “Reconnect Gmail; Alfred no longer has access.”                                              |
| `choose_account`          | Show the available identities and require a choice.                                          |
| `insufficient_permission` | Name the required capability and how to grant it.                                            |
| `no_tool_surface`         | “Alfred cannot automate Slack yet.” Do not offer a fake connection fix.                      |
| `provider_unhealthy`      | Preserve the draft and offer retry/status; do not describe this as an authorization problem. |

The existing pure capability resolver remains useful. It should compute
readiness and block `active`, rather than decide whether the user's draft is
allowed to exist.

### 4. Draft and active are different user promises

**Sourced fact.** Zapier creates new workflows as drafts by default, auto-saves
them, and only turns them on when the user publishes. A published workflow can
continue running while a later draft is edited. ([Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions))
n8n also keeps all edits in draft until publish, pins production to a published
version, and supports an unpublished-changes state without changing production.
([n8n save and publish](https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows/))

**Recommendation for Alfred.** Change the plan's leaning from “approval inserts
`active`” to “authoring saves `draft`; activation publishes a version.” The
fast-path can still feel like one compact conversation:

1. Alfred generates the proposal.
2. The card reports `Ready to activate` (or names blockers).
3. The user's `Activate` click publishes version 1.

That is not gratuitous ceremony: the card is the boundary where the user agrees
to unattended future execution. A separate “Save draft” button need not be
required because saving can be automatic.

Edits to an active workflow should create unpublished changes while the last
published version continues to run, or require the workflow to be paused before
editing. Silently changing the interpreted brief of a live recurring workflow
is the weakest option because run history then becomes hard to explain. Every
run should identify the workflow version it executed.

### 5. Preview, validation, and live testing must not be conflated

**Sourced fact.** Zapier action tests and end-to-end tests perform actions in the
connected app and explicitly warn that they may make changes. Trigger tests load
records for review; testing is mandatory for the trigger and structural Filter
and Paths steps, but other action tests can be skipped. ([Zapier test steps](https://help.zapier.com/hc/en-us/articles/18811411817741-Test-Zap-steps))
n8n's manual executions are ad-hoc tests from the editor; it can freeze node
output, partially execute a path, or temporarily disable nodes to avoid touching
services, while production execution requires a non-manual trigger and publish.
([n8n execution types](https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions/))
Apple's creation flow offers a test action, then shows a summary before the
automation is finished. ([Apple create a personal automation](https://support.apple.com/en-ie/guide/shortcuts/apdfbdbd7123/ios))

**Recommendation for Alfred.** Give v1 two honestly named controls:

- **Preview interpretation**: no external writes. Resolve connections, render
  the concrete trigger, show the intended capability outline, and optionally run
  reads needed to demonstrate the expected input/output shape. Any write is
  planned and displayed, not dispatched.
- **Run a test now**: execute the workflow once with a manual/test trigger. Before
  dispatch, say which real external effects may happen and retain the normal HIL
  gates. Show the resulting run in history with `trigger: test`.

Do not promise a generic “dry run” for an interpreted agent unless tool dispatch
is technically prevented. Prompting the model not to write is not a side-effect
boundary.

Activation readiness should require deterministic trigger validation,
capability/account resolution, and a successful no-write preview. A full live
test can be recommended rather than mandatory where representative trigger data
does not exist or the only meaningful test would create an undesirable effect.
Show `Tested` or `Not tested` on the activation review.

### 6. Approval should cover the inferred contract, not merely a prose brief

**Sourced fact.** Zapier's confirmation-first Copilot mode presents proposed
steps, apps, action events, account connections, and field values before acting.
Its automatic mode still summarizes completed work, exposes reasoning, and
lists items the user must finish. ([Zapier Copilot](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows))
Apple supports both ask-before-running and run-without-asking automation modes;
disabling the confirmation requires an explicit “Don't Ask” choice.
([Apple automation confirmation](https://support.apple.com/en-euro/guide/shortcuts/-apd602971e63/ios))

**Recommendation for Alfred.** The activation approval should answer five
questions without requiring the user to inspect implementation detail:

1. **When will it run?** Exact trigger, timezone, next run, and event filter.
2. **What will Alfred try to do?** A short ordered capability/intent outline plus
   the full interpreted brief behind an expander.
3. **Where and as whom?** The exact integration account/mailbox/workspace, not
   only `gmail` or `slack`.
4. **What can change externally?** Read, create, send, update, delete, or other
   capability categories, with high-impact actions called out.
5. **What remains uncertain?** Assumptions, untested status, and any values to be
   chosen at run time.

This is stronger than trusting the boss-provided `integrations[]`. Preserve that
enumeration as model input, but derive the review from the resolved tool/action
surface as well as deterministic `@` mentions. If Alfred cannot explain what
capability a brief may invoke, the proposal is not ready for unattended
activation.

Author approval grants permission to activate this workflow definition; it
should not erase per-run approval floors for high-risk actions. Those are
different consent scopes.

### 7. Run history needs diagnosis and recovery, not just a result summary

**Sourced fact.** Zapier history exposes run status, per-step status, timestamp,
data received/sent, and the exact workflow version used. It can replay
unsuccessful runs. ([Zapier run history](https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history))
Zapier distinguishes errored, safely halted, held, handled-error, and scheduled
retry states rather than labeling every non-success as failure.
([Zapier troubleshooting statuses](https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows))
For replay, Zapier can retry only errored steps or create a new run from previous
trigger data; expired connections must be reconnected before replay.
([Zapier replay](https://help.zapier.com/hc/en-us/articles/19220226086797-What-is-replay))
n8n allows retry with the original workflow or the currently saved workflow and
can load failed execution data back into the editor for diagnosis.
([n8n executions](https://docs.n8n.io/workflows/executions/all-executions/),
[n8n debug executions](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions/))
IFTTT's activity feed records ran, failed, skipped, connection changes, and
step-level Trigger/Query/Action details and values. ([IFTTT Activity feed](https://help.ifttt.com/hc/en-us/articles/115004914234-How-to-use-the-IFTTT-Activity-feed),
[IFTTT troubleshooting activity](https://help.ifttt.com/hc/en-us/articles/37696590075547-How-do-I-check-my-Applet-activity-and-troubleshoot-issues))

**Recommendation for Alfred.** Model at least these run outcomes distinctly:

| Outcome            | Meaning                                                              | Primary recovery                               |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| `succeeded`        | Intended run completed                                               | Inspect result                                 |
| `skipped`          | Trigger fired but a declared condition prevented action              | Inspect reason; no retry by default            |
| `blocked`          | Run could not start because authorization/capability was unavailable | Connect/re-authorize, then resume/replay       |
| `waiting_approval` | A run-specific HIL gate is pending                                   | Approve or reject                              |
| `failed`           | Execution started and encountered an error                           | Inspect failed operation; retry only when safe |
| `outcome_unknown`  | A mutating call may have happened but confirmation was lost          | Reconcile; never blind auto-retry              |
| `cancelled`        | User/system stopped local execution                                  | Report any already-completed effects           |

Each run view should show the trigger input/time, test versus production,
workflow version, connection identities, concise result, attempted capabilities,
completed effects, and the exact blocker/failure. Keep a friendly summary first;
put tool-level details behind expansion.

The proposed pre-run health check should **hold the run before the first boss
turn** and mark the workflow `needs attention`; it should not necessarily pause
the workflow permanently on the first transient provider failure. Revoked or
expired authorization can immediately block all future runs until reconnection.
Temporary provider errors should use bounded retries and only escalate the
workflow after repeated failure. IFTTT's first-party behavior supports this
distinction: it avoids disabling after one or two failures but can disable after
consistent failures. ([IFTTT automatic disabling](https://help.ifttt.com/hc/en-us/articles/360014195734-Why-do-Applets-and-connections-get-disabled))

For event-triggered workflows, retain the triggering payload while held when
policy and storage limits allow. After reconnection, offer `Resume this run` and
say whether it uses the original published version or the latest version. For
mutations, retry must remain subject to Alfred's existing idempotency and
ambiguous-write rules; recovery UX must never imply that replay is always safe.

## Recommended v1 lifecycle

The minimum coherent user-facing model is:

| Workflow state    | Meaning                                                                                     | Can trigger production runs?                                                   |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `draft`           | Intent is saved; proposal may still need editing, connection, account choice, or validation | No                                                                             |
| `ready`           | Required trigger and capabilities resolve; may be previewed/tested                          | No                                                                             |
| `active`          | A specific reviewed version is published                                                    | Yes                                                                            |
| `needs_attention` | Published definition exists, but current health blocks new execution                        | No; incoming runs are held or explicitly skipped according to retention policy |
| `paused`          | User intentionally stopped it                                                               | No                                                                             |
| `archived`        | Kept for history but removed from normal use                                                | No                                                                             |

`ready` can be computed rather than persisted. The important product invariants
are that incomplete work survives, only a reviewed version becomes active, and
health degradation is not confused with a user pause.

The happy path remains short:

```text
User describes workflow
  → Alfred presents resolved proposal
  → side-effect-free preview/readiness check passes
  → user activates
  → version 1 is published and next run is shown
```

The missing-connection path becomes resumable:

```text
User describes Slack workflow
  → Alfred saves draft and marks “Slack unavailable”
  → Connect (if supported) or honest “not supported yet”
  → same draft is re-resolved
  → preview → activate
```

## Concrete changes suggested for `workflows-v1.md`

### Must change before implementation

1. Change **author-time hard gate only** from “nothing persists” to “nothing
   activates.” Persist a blocked draft and resume it after connection setup.
2. Change approval persistence from direct `active` insertion to a draft plus an
   explicit activation/published-version transition. The UI may present this as
   one card on the fully-ready happy path.
3. Expand trigger acceptance criteria to include timezone, human-readable exact
   recurrence/event semantics, selected source account, and next expected run.
4. Add a no-write interpretation preview. Rename any true execution to `Test
run`, disclose external effects, and keep normal write approvals.
5. Extend the run-report contract beyond `status + trigger + summary` to include
   workflow version, test/production, reason-specific non-success, attempted and
   completed effects, and recovery actions.
6. Replace “pause immediately on any regressed capability” with a reason-aware
   pre-run hold: authorization loss blocks until reconnect; transient outages use
   bounded recovery and escalation. Never proceed with a partial capability set.

### Keep from the current plan

- Chat-authored workflow proposals and a shared validated server-side create
  path.
- Interpreted-only execution for v1.
- Pure capability resolution over current availability.
- The deterministic union of boss enumeration and explicit `@` mentions as a
  baseline signal.
- Dispatcher enforcement of allowed integrations and existing per-action HIL
  floors.
- Concrete trigger resolution before approval.
- No DAG interpreter, sandbox, compiled handler, or generalized indexing engine
  in the v1 dependency chain.

### Defer, but leave seams for

- Separate draft and published versions for edits to already-active workflows if
  that is too large for the first slice; at minimum record an immutable
  definition/version snapshot on every run.
- Partial test execution and editable/mock trigger fixtures.
- Automatic replay policy by failure class.
- Organization-level publish approval and policy controls.

## Pressure tests for the product review

1. The user says “every morning” but has no saved preferred time. Does Alfred ask
   or silently choose? The recommendation is an editable proposed time, with
   activation blocked until the exact schedule is visible.
2. Two Gmail accounts are active. Which identity appears in the card, and can the
   user switch it without re-authoring?
3. Slack is named but Alfred has no Slack tool surface. Does the product say
   “connect” incorrectly? It must say unsupported and preserve the draft.
4. A test would send a real message. Is that obvious before the click, and does
   the normal write confirmation still appear?
5. Gmail authorization expires after an event is received. Is the event payload
   retained, and does reconnect offer to resume it?
6. A write times out. Does history say “failed” and invite a duplicate, or
   “outcome unknown” and offer reconciliation?
7. The user edits an active brief while a run starts. Can history prove which
   definition executed?
8. A provider has a five-minute outage. Does one transient failure permanently
   pause a daily workflow, or does the run enter a truthful recoverable state?

## Source selection note

Only first-party product documentation from Zapier, n8n, Apple, and IFTTT was
used. These products are evidence for interaction patterns, not proof that their
exact lifecycle or retry policy is correct for Alfred. All Alfred-specific state
names and recommendations above are synthesis.
