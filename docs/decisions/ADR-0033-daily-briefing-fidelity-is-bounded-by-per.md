# ADR-0033 — Daily briefing fidelity is bounded by per-source OAuth: Google now, GitHub queued

**Decision.** The LLM-composed daily briefing (built atop m10, scaffolded 2026-05-21) is explicitly scoped to whatever per-source data alfred has ingested. v1 ships against Gmail only (the existing `briefing` feature in `GOOGLE_FEATURE_SCOPES`); Google Calendar (`calendar.readonly`) is the next scope to land and is treated as a hard prerequisite for "what's on today" / "what's on tomorrow" content; GitHub OAuth is queued as the next integration boundary after that and is the prerequisite for accurate PR-state awareness. The briefing agent's tool surface (`list_calendar_events`, `list_action_items`, `list_meeting_preps` in the scaffold) is shaped now to consume those signals when they exist and returns `[]` until they do — no prompt rewrites needed when each lands.

**Why this is its own ADR.** ADR-0025 #2 committed to a daily briefing but pinned v1 at "inbox-only, calendar deferred." The 2026-05-21 scaffold supersedes that compose step with an LLM agent — at which point fidelity stops being a UI question and starts being an integration question. A user-visible regression we hit on day one: the morning briefing re-surfaced PRs the user had already merged, because alfred has no GitHub read path and can't verify state. That's not a model failure; it's a scope failure. The decision deserves its own ADR so subsequent integration work doesn't reopen the question of whether briefings can "fake it" without the underlying signal.

**Why we don't paper over the gap with cleverness.** The temptation is to LLM-route harder: have the agent infer merge state from email signal ("if there's been no review-comment email about PR #16 in 5 days, assume it's merged"). Rejected because (a) the false-positive cost is high — the briefing tells the user a stale thing as fresh — and (b) the right primitive is the integration, not a heuristic. The prompt-level guardrail we did add ("don't re-surface a PR named in a recent prior briefing absent fresh signal") is a band-aid: it stops repeated noise but doesn't gain truth; with GitHub it goes away.

**Integration sequencing.**

1. **Google Calendar** (`calendar.readonly`). Smallest scope expansion — the existing `GOOGLE_FEATURE_SCOPES` shape already supports adding `calendar` as a feature; the briefing scope set picks it up via `scopesForFeatures(['briefing'])` once added. Wires the agent's `list_calendar_events` stub into a real read. Unlocks: meeting-aware morning briefings, evening "tomorrow looks like…" line.
2. **GitHub OAuth** (`repo` read, or a tighter `public_repo` if the user's repos are public). Larger scope of work — new integration credential, ingestion, polling/webhook story per ADR-0024. Unlocks: PR-state awareness in briefings, the future meeting-prep agent's "this PR is the engineering-standup topic" cross-reference, and the action-items agent's GitHub webhook trigger (per Ronit's background-agents post).
3. **Everything else** (Linear, Slack DM, Notion) — deferred. Each opens its own ADR when ingestion lands.

**What does NOT change.**

- The agent's tool surface is stable. `list_calendar_events`, `list_action_items`, `list_meeting_preps` already exist and return `[]`; the agent's prompt already names them. When each is wired, no agent code or prompt rewrite is required.
- The briefing workflow shape (`gather → compose → persist → send`) doesn't change per integration; the watermark + prior-briefing memory layer is generic.
- The OAuth refactor that landed alongside m10 (`GOOGLE_FEATURE_SCOPES` + `scopesForFeatures(features?)`) is the right shape for per-feature scope opt-in. The same `requireScopes()` guard pattern transplants to GitHub when it lands.
- The "safety through architecture" rule from the background-agents recon: briefing agents have no `send_email`, no `draft_reply`, no general `web_search`. Adding integrations expands the _read_ surface, never the _write_ surface, regardless of OAuth scopes available on the underlying token.

**Alternatives.**

- (a) Build GitHub state into the briefing now by parsing PR URLs out of email bodies and screen-scraping the merge state from the GitHub web UI (rejected — fragile, not a real integration, doesn't unlock anything beyond this one symptom).
- (b) Block the LLM-composed briefing from shipping until GitHub is wired (rejected — Gmail-only briefings still beat the deterministic m10 for inbox content, and Calendar lands sooner; staging the integrations is the whole point).
- (c) Drop PR mentions from briefings entirely until GitHub is wired (rejected — the user routinely cares about review-comment emails on their own PRs; surfacing those with the noted band-aid is better than silence).

**Trace back to the symptom.** 2026-05-21 morning smoke output included "PR #16, PR #24, and PR #25 are all ready for you to take a look" — all three were already merged. The prompt-level guard now in place reduces repeat-noise; the actual fix is GitHub OAuth.

**Amendment (2026-05-26) — inbox-only bound widened to full cross-source gather (ADR-0041).**

The "v1 ships against Gmail only" position is superseded by ADR-0041's five-source gather: email triage rollup + Google Calendar + integration activity + Weather + day-of-week. The integration-sequencing argument here remains correct (each source is gated on its OAuth scope or external dependency landing first), but the briefing workflow itself no longer ships in an "inbox-only" v1 shape. The agent's deterministic gather (`list_calendar_events`, `list_action_items`, `list_meeting_preps` stubs returning `[]`) is replaced by a typed `BriefingContributor<T>` contract per source; each contributor returns `null` or an empty activity list until its underlying integration is wired, and the composer's prompt handles empty cases verbatim. The "don't paper over the gap with cleverness" rule still applies — when a direct provider state isn't readable, the briefing must say so, omit, or mark the item as email-triage backfill rather than infer. The "safety through architecture" rule (briefing agents have no `send_email`, no `draft_reply`, no general `web_search`) is preserved by ADR-0041's compose call having no tool surface at all — it's a single structured-output `generateText` over the gather, not an agent loop.

**Amendment (2026-05-27) — the "never expand the write surface" rule is superseded by ADR-0043.**

The blanket claim that integrations "expand the _read_ surface, never the _write_ surface, regardless of OAuth scopes" no longer holds product-wide. ADR-0043 makes write tools first-class, authorized by the composition of tool registry + active tool exposure bounded by `workflows.allowed_integrations` + `user action policy` (default `gated`). The specific guarantee that _the briefing_ never writes is unchanged — but it now rests on ADR-0041's compose call being tool-free by construction, not on a global no-write rule. Read this ADR's "expands read, never write" line as scoped to the briefing/compose path; ADR-0043 governs everywhere else.
