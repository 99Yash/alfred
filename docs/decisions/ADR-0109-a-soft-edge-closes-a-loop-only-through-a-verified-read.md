# ADR-0109 — A soft edge closes a loop only through a verified read: the model picks reads and cites them, and code checks identity, time, and state

**Status.** Proposed, 2026-10-20. Slice 1 (rule 2, identity containment) is built. Slices 2 to 4 are not built. This ADR amends ADR-0062 (propose/dispose and the #1196 MCP health amendment) and ADR-0092 D5 (the fallback floor of each vendor). It keeps ADR-0048-D and ADR-0103.

## Context

A briefing loop closes only when its evidence joins a stored work object, and that object reads as resolved. Today each provider joins through its own text grammar: `object-state/railway-mail.ts`, `sentry-issue-url.ts`, the GitHub adapter, and `contracts/loop-key.ts`. PR #1432 added the Railway grammar on 2026-10-20. The owner connects any integration through MCP, so one code file for each vendor does not scale. A connected MCP provider with no code file can never close a loop. The #1196 health mapping can read the state of an MCP object, but nothing joins its output to the mail, so it has no adopter.

A failed deployment does not need a redeploy to close. A later successful deployment on the same target supersedes it (#1093). The question is how to prove "same target" and "later" for a provider that Alfred has no code for.

The model alone cannot do the join. On 2026-10-19 the evening briefing held both the line "Railway deployment succeeded: web (production)" and the build-failure mail, and it did not join them.

### Measured in production, 2026-10-20

The probe read `documents` (1195 Gmail rows, 2026-09-05 to 2026-10-20), `integration_objects`, and `integration_object_keys`.

| Provider sender | Mails | Joined by object URL | Joined by stored key | Note |
| --- | --- | --- | --- | --- |
| GitHub | 345 | 36 | 15 | Most GitHub mail joins through threading headers, not body text. |
| Railway | 22 | 0 | 1 | 9 are "Build failed for alfred". Railway object rows store no URL and no title. |
| Vercel | 41 | 0 | 0 | 32 are `vercel[bot]` comments on GitHub PRs (GitHub mail). 8 come from `notifications@vercel.com`, and 3 of them are deployment failures. |
| Sentry | 14 | 0 | 0 | All 14 are weekly reports or marketing. No issue alert arrived. |

Four facts follow:

1. **The object URL is not a universal key.** The Railway pull stores no URL, and a Vercel row stores the public deployment URL, which no mail contains.
2. **The identity values of the object are in the mail.** Each of the 9 Railway failure mails contains the `project_id`, `service_id`, and `environment_id` of exactly one stored `deployment_target`. Each of these targets has a later success (2026-10-19 11:44).
3. **Two attributes are not enough.** `project_id` plus `environment_id` match 4 targets, because one project has 4 services in one environment. A rule of "any two matching attributes" links nothing true here. Only the full identity tuple is unique.
4. **The mail can write a value in a different form.** Each of the 3 Vercel failure mails links to `vercel.com/<team>/<project>/<id>`. The `<id>` is the stored `deployment_id` without its `dpl_` prefix, and each of the 3 ids is a stored key. An exact text match finds none of them.

## Decision

### 1. Two classes of edge

- A **hard edge** links evidence to exactly one object through an identity: a stored key (`integration_object_keys`), or the full identity tuple of the object (rule 2). A hard edge closes a loop through the existing path (ADR-0062, ADR-0103).
- A **soft edge** links evidence to an object through co-occurrence only: the same sender domain, the same service name, or a near time. A soft edge never closes a loop by itself. It nominates the loop for the verifier (rule 3).

### 2. Identity containment is a generic hard edge, with no model

Each object kind declares its identity attributes as data in the registry (`ObjectKindDef.identityAttributes`). Examples: Railway `deployment_target` declares `project_id`, `service_id`, `environment_id`. Sentry `issue` declares `issue_id`. Vercel `deployment_attempt` declares `deployment_id`.

Evidence links to an object when all of these conditions are true:

- Each identity value of the object occurs in the evidence text on a token boundary. A kind can declare a prefix that the provider removes in its links (Vercel `deployment_id`: `dpl_`). Then the value without the prefix also counts. The prefix is data on the kind, not a grammar.
- Each value is **strong**: 8 characters or more, with at least one digit. The length counts the value without its declared prefix. A UUID, a numeric id, and a hex SHA are strong. `main` and `production` are weak.
- The tuple has at least 2 strong values, or it is 1 strong value that the kind declares as a unique key (`issue_id`, `deployment_id`).
- Exactly one object of the kind matches. Two matches link nothing.

A kind that has weak values in its tuple (Vercel `deployment_target` is repo, branch, environment) cannot link by containment. It keeps its current path.

This rule replaces a URL grammar for each vendor. When it lands for Railway and Sentry, `railway-mail.ts` and `sentry-issue-url.ts` become dead code. The sender gate (`isRailwaySender`) stays as data on the integration entry, because an `about` reading still needs it.

### 3. The runtime closure verifier: the model reads, the code decides

The verifier runs at gather, after the verified pull and after reconciliation. It takes only the loops that are still live, have a soft edge, and have no hard edge.

1. **Read.** A model (a `route()` entry on the cheap tier, ADR-0051) gets the loop evidence and a list of allowed read tools. It may call at most 3 reads for each loop. The allowed tools are:
   - the built-in live readers (`LIVE_STATE_READERS`),
   - the object-state store (`resolveByKey`, `getState`, `list`),
   - an MCP tool whose published descriptor has `annotations.readOnlyHint === true` and whose current descriptor hash the owner approved for this use one time.
2. **Claim.** The model returns a structured claim. Each value in the claim cites a JSON path in a raw tool result of this run. The claim names the identity values, the state value, and the time value.
3. **Check.** Code verifies the claim. All of these checks must pass:
   - **Citation.** Each cited value is equal to the raw result at its path. The code reads the raw result from the run record, not from the model output.
   - **Link.** The identity values meet rule 2 against both the evidence text and one item of the result: at least 2 strong values, or 1 declared unique key. Exactly one item in the result matches. Exactly one candidate passes for the loop.
   - **State.** The state value is terminal and positive. For a built-in kind, it is a state in `closesAskOn`. For an MCP tool, the approved `stateMappings` maps it to `resolved`. With no mapping, it must be equal (case-insensitive) to one value in a fixed list in code: `success`, `succeeded`, `ready`, `resolved`, `merged`, `completed`, `passed`, `healthy`. `closed` is not in the list, because a closed issue can be "won't fix".
   - **Time.** The cited time is later than the newest failure evidence for the same identity. Failure evidence is any mail or stored object row in the store. A success that is older than a later failure does not close.
4. **Close.** A loop that passes closes with a new closure source, `verified_inference` (added to `OBJECT_STATE_CLOSURE_SOURCES`). The close stores a receipt: the tool, a hash of its arguments, the cited paths and values, and the result of each check. The briefing shows the receipt in one line, for example: "web (production) succeeded at 11:44 after the 09:10 failure; matched project, service, and environment."
5. **Reopen.** New failure evidence for the same identity reopens the loop. A `verified_inference` close never suppresses a later failure.

Any fault keeps the loop live: a timeout, a refused tool, a citation that does not match, or an ambiguous candidate. Absence never closes a loop (ADR-0048-D).

### 4. Promotion: a repeated inference becomes data

When 3 `verified_inference` closes share one shape, the verifier drafts a template for the owner. The shape is the sender domain, the tool, and the identity paths. The draft is an `identityAttributes` declaration or an approved #1196 health mapping. The owner approves it, and after that the join is a hard edge and needs no model (ADR-0050 D4). Nothing applies a draft without approval.

### 5. Bounds

- At most 5 loops for each gather, 3 reads for each loop, and 20 seconds for the whole pass.
- A loop that the verifier read and could not close is not read again until new evidence arrives for it.

## Changes to existing decisions

- **ADR-0062, propose/dispose.** The text "an LLM may propose a key but never asserts state" stays true. In this lane the model also chooses reads and cites values. It asserts nothing: the code reads each value from the raw result. Alternative (c), "email text is not closure evidence", stays true. The close comes from a read, and the mail only supplies identity values that the code checks.
- **ADR-0062 #1196.** The text "no model chooses the tool or arguments" gets one exception: the verifier lane may choose arguments for a tool that the owner approved for verifier reads. The tool must still assert `readOnlyHint === true` at approval and at the broker.
- **ADR-0092 D5.** The vendor regex floor shrinks through rule 2, not through new adapters.
- **`LOOP_RELEVANCE_VERDICTS`** (`packages/contracts/src/briefing.ts`). The comment says a verdict changes "phrasing and priority only, never closure". That stays true for verdicts. The verifier is a separate path that writes a closure source, not a verdict.
- **`OBJECT_STATE_CLOSURE_SOURCES`.** The comment "Text evidence is not a member" stays true. `verified_inference` names a read, not text.

## Alternatives

- **The model decides the close.** Rejected. It failed on 2026-10-19, and a confident wrong close hides a real failure.
- **A soft edge never closes.** This was the first recommendation. The owner overruled it on 2026-10-20: if a read can confirm the close, Alfred must use it.
- **One grammar file for each vendor.** Rejected. It does not reach an MCP provider, and it grows with each integration.
- **The canonical object URL as the universal key.** Rejected as the only rule. The production probe shows that stored objects often have no URL, or a different URL from the mail.
- **"Any two matching attributes."** Rejected. In production, `project_id` plus `environment_id` match 4 Railway targets.
- **Probability scores on edges (the Glean context graph).** Not used for closure. A score has no threshold that makes a close safe. Scores can rank soft edges for the verifier later.

## Implementation order

1. Add `identityAttributes` and the declared prefix to the registry, and the containment join for Railway `deployment_target`, Vercel `deployment_attempt`, and Sentry `issue`. Delete `railway-mail.ts` and `sentry-issue-url.ts` when the join replaces them.
2. Add the verifier with built-in readers and the store only. Add `verified_inference` and the briefing receipt line.
3. Add owner approval of MCP tools for verifier reads, and the fallback list of positive states.
4. Add drafts of templates (rule 4).

## Slice 1 as built

- The registry field is `ObjectKindDef.identity`. It is `{ uniqueKey }` or `{ tuple }` with 2 or more attributes, so the type rejects one attribute that is not a key. Each attribute can declare a `droppedPrefix` and a `linkLabel`.
- The provider domains are data: `IntegrationObjectDef.domains`. `isNotificationSender` reads them for the sender gate, and `collectProviderLinks` reads them for link hosts. The object-state registry holds them, not the ADR-0093 integration entry, because Railway is a `planned` entry there.
- `proposeReconcileCandidates` returns the adapter keys and an identity probe. `reconcileEvidence` resolves the probe with one query for each declared kind. The query stops before the next chunk when the caller aborts.
- `railway-mail.ts` and `sentry-issue-url.ts` are deleted. The Railway adapter proposes nothing. The Sentry adapter proposes only `short_id`. The Sentry reducer stores a permalink only when `linkNamesObject` finds the issue id after `/issues/`.

### Correction to rule 2 (review of PR #1434)

The first build put all tokens of a mail in one set. That set lost which value came from which link. A mail with two Railway links (P, S1, E1) and (P, S2, E2) then matched a stored target (P, S1, E2) that neither link names. A bare number in prose ("Billing reference: 20261020") matched a stored Sentry `issue_id`. ADR-0103 keeps an ask when evidence has several plausible primary objects, and a live read cannot repair a wrong link. Rule 2 now reads:

- **One link is one reference.** Only a link on a provider domain counts. Values from two links never combine into one tuple. Text outside a link names nothing.
- **A label gives the kind context.** `linkLabel` is the path segment or query parameter before the value: Railway `project`, `service`, `environmentId`; Sentry `issues`. A link proves an object (a hard edge, match `identity`) only when each value sits after its label.
- **Ambiguity comes from the text, before the database.** Under `about`, a mail whose links name two different labeled tuples, or a link with two values for one label, links nothing. The database cannot see an object that it does not store, so it cannot decide this.
- **No label, no proof.** A kind with an unlabeled value (Vercel `deployment_attempt`: `vercel.com/<team>/<project>/<id>`) links by containment in one link, but the link only nominates (a soft edge, match `nomination`, `closesAskAs: null`). A Vercel attempt never closes a loop anyway.

### Production replay, 2026-10-20

Through the real `reconcileEvidence` under `about`, after the correction: each of the 9 Railway build-failure mails linked to exactly one `deployment_target` as `identity`. One Railway "Image Auto Upgraded" mail also linked to one target. The deleted grammar linked that mail too. Each of the 3 Vercel failure mails linked to exactly one `deployment_attempt` as `nomination`. No Sentry issue alert was in the corpus.

## Verification

The repo adds no tests. Proof comes from production replay:

- Run the 2026-10-20 probe again after slice 1. Each of the 9 Railway failure mails must link to exactly one target, and each of the 3 Vercel failure mails to exactly one attempt, by containment.
- Before slice 2 ships, replay the briefings of 2026-10-18 and 2026-10-19 with the verifier on. Compare the closed loops with and without it (paired diff, not an aggregate score).

## Residual risks

- **A tool can lie.** An MCP server can set `readOnlyHint` on a tool that writes. The one-time owner approval for each descriptor hash reduces this risk. It does not remove it.
- **A uniqueness guard can resolve wrongly when one candidate drops out** (lesson `a-classifier-that-only-moves-to-null-can-still-resolve-wrongly-through-a-count-guard`). If the true object is missing a value in the evidence, and another object matches all its values, the link goes to the wrong object. The strong-value floor makes a false full match rare, but not impossible.
- **The provider list can lag.** A read can return an older success before a newer failure appears. The time check uses only the evidence that Alfred has. The reopen rule repairs this when the failure arrives.
- **Cost.** The verifier calls a model only for loops that have a soft edge and no hard edge. Each approved template removes one class of these loops.
