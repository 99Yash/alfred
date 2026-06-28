# Memory capture hardening (#330, epic #218)

Fixes #330: the per-document fact-extraction path harvests **transactional email metadata and third-party attributes as durable `user_facts`**, and there is **no conflict detection** for single-valued identity keys. This is the capture-side root of the identity-hallucination bug (read-side companion #329 shipped in #332). Recurrence of `.lessons/user-facts-document-metadata-noise.md` — the prior prompt-rubric + narrow-deny-list fix did not hold.

Dev evidence (2026-06-28, re-confirmed at grill time): `user_facts` = **921 rows**; 170 `document/confirmed` + 71 `document/proposed` are junk. `home_city` has **12** active confirmed values (contacts' cities), `home_country` **7** (Romania/Italy/Germany/Ireland…), `github_username` **8** (incl. the `Alfred` bot + `mattpocock`), `phone_number` carries a contact's `+40212641794`, `personal_website = sandromaglione.com`. Three+ co-equal `confirmed, 0.95` values for single-valued identity keys — a contradiction the system never flagged.

## The load-bearing premises (do not violate)

1. **The prompt is defense-in-depth, never the safety floor.** Rules 1–8 in `extraction.ts` already say "don't harvest job-posting companies, don't store third-party attributes" and demonstrably failed on exactly those cases. The fix is **deterministic, code-enforced gates**; the prompt stays as recall guidance only.
2. **`facts.ts` owns write invariants; the workflow owns document-context attribution.** `proposeFact` must never reach back into `documents` or infer sender identity. The only check that needs document context — "is this doc authored by the user?" — lives in the workflow, the one place with `doc.metadata` + the connected-account email.
3. **Canonicalization ≠ rejection.** Alias-mapping (`current_company`/`company_name`→`employer`) prevents duplicate identities and runs for **all** sources. Unknown-key *rejection* is a trust/source policy and fires for `document` only. They are different policies and must not be conflated.
4. **Plan the ontology once, and migrate the read side with it.** `read_user_context` may expose DTO fields named `currentCompany` / `currentRole` / `currentLocation`, but those are presentation fields. Storage keys should be durable fact concepts (`employer`, `job_title`, `location`, `full_name`) whose currentness is represented by `status` + `valid_from` / `valid_until`, not by baking `current_` into the key. #330 therefore includes updating the #332 read-side profile spine and canonicalizing live `current_*` rows; no temporary v1/v2 split.
5. **Identity has better sources than inbound email.** Cold-start research (currently `name`/`home_city`/`home_country`/`company`/`personal_site`/`github_username`…), user edits, and explicit `system.remember` are the authoritative origins. Under-learning identity from documents is nearly free; over-learning is the bug. The attribution gate therefore defaults to **deny**.

## Three enforcement layers

### 1. `@alfred/contracts` — *what keys exist* (pure, web-safe, no Node deps)

- The canonical key registry must be **one source of truth**, not a second table next to `FACT_ONTOLOGY` in `user-model.ts`.
  - Extend/update `FACT_ONTOLOGY` into the #330 vocabulary and export `CANONICAL_FACT_KEYS` from that same underlying map. Do not leave two unconnected registries both claiming to be canonical.
  - Canonical identity/work/profile storage keys: `full_name`, `first_name`, `last_name`, `user_nickname`, `bio_summary`, `work_summary`, `employer`, `job_title`, `team`, `manager`, `location`, `home_city`, `home_country`, `timezone`, `birthday`, `marital_status`, `spouse_name`, `personal_site`, `github_username`, `twitter_handle`, `linkedin_url`, `family_summary`, `notable_relations`.
  - Do not leave `current_company`/`company`/`employer`, `current_role`/`job_title`, `current_location`/`location`, `full_name`/`name`, or `personal_site`/`personal_website` as parallel storage keys. Aliases handle legacy spelling; the canonical storage set is singular.
- `CANONICAL_FACT_KEYS` — exact identity/profile/preference keys, derived from that one registry.
- `CANONICAL_FACT_PREFIXES` — `relationship:`, `pref:`.
- `FACT_KEY_ALIASES` — **explicit legacy map only**, no fuzzy/semantic guessing:
  - `current_company → employer`, `company → employer`, `company_name → employer`
  - `current_role → job_title`, `role → job_title`
  - `current_work → work_summary`
  - `current_location → location`, `name → full_name`
  - `personal_website → personal_site` (+ any others observed in dev data at build time, enumerated, not pattern-matched).
  - Non-aliases that must stay rejected: `website`, `url`, `homepage`, `company_url`. Aliases are an observed-intent compatibility shim, **not** a migration dumping ground.
- `canonicalizeFactKey(key)`:
  ```ts
  type CanonicalizeResult =
    | { ok: true; key: string; wasAlias: false }
    | { ok: true; key: string; wasAlias: true; originalKey: string }
    | { ok: false; reason: "unknown_key" };
  ```
  Also normalizes the open `relationship:<email>` shape (lowercased email); an unparseable suffix returns `ok:false`.

### 2. `packages/api/src/modules/memory/fact-policy.ts` — *which sources write which keys*

- `classifyDocumentFactKey(canonicalKey) → "tierA" | "tierB" | "not_writable"`
  - **Tier A (authorship-free):** `relationship:<email>` only — an inbound email legitimately establishes *the user's* social graph.
  - **Tier B (authorship-required):** `full_name`, `first_name`, `last_name`, `user_nickname`, `bio_summary`, `work_summary`, `employer`, `job_title`, `team`, `manager`, `location`, `home_city`, `home_country`, `timezone`, `birthday`, `marital_status`, `spouse_name`, `personal_site`, `github_username`, `twitter_handle`, `linkedin_url`, `family_summary`, `notable_relations`.
  - **`not_writable`:** `pref:*`, `standing_instruction`, `phone_number`, unknown keys, and everything else (the junk).
- `validateFactValueForKey(canonicalKey, value)` — context-free structural checks (e.g. `relationship` value shape `{ role, since? }`). Source-agnostic invariant.
- `SINGLE_VALUED_KEYS` (source-agnostic): `full_name, first_name, last_name, user_nickname, employer, work_summary, job_title, team, manager, location, home_city, home_country, timezone, birthday, marital_status, spouse_name, personal_site, github_username, twitter_handle, linkedin_url, bio_summary`.
  - **Multi-valued (no conflict check):** `relationship:*`, `pref:*`, `phone_number` (work/personal/temporary numbers all legit).
  - `employer`/`job_title`/`location`/`home_city`/`home_country` are modeled as **current active profile facts**; historical values are represented by superseded rows and validity windows, not separate keys. `team`/`manager`/`personal_site` are **primary/current** for this slice; add `affiliation`/`additional_site` later only if plural is genuinely needed. Don't weaken the fix for edge cases.
- `authoredByUser(doc, selfIdentity) → Authorship` — evidence-returning, conservative-default-`false`, and provider-discriminated rather than stringly-typed:
  ```ts
  type AuthorshipSource =
    | "gmail"
    | "slack"
    | "github"
    | "gcal"
    | "notion"
    | "imessage"
    | "upload"
    | "unknown";

  type AuthorshipIdentity =
    | { kind: "email"; value: string; accountId?: string }
    | { kind: "provider_user_id"; provider: "slack" | "github"; value: string; workspaceId?: string }
    | { kind: "provider_login"; provider: "github"; value: string };

  type AuthorshipProof =
    | {
        source: "gmail";
        method: "sent_flag";
        accountId: string | null;
        accountEmail: string | null;
        fromEmail: string | null;
      }
    | {
        source: "gmail";
        method: "from_connected_account";
        accountId: string | null;
        accountEmail: string;
        fromEmail: string;
      }
    | {
        source: "slack";
        method: "author_user_id" | "author_email";
        observed: AuthorshipIdentity;
        matchedSelf: AuthorshipIdentity;
      }
    | {
        source: "github";
        method: "author_id" | "author_login";
        observed: AuthorshipIdentity;
        matchedSelf: AuthorshipIdentity;
      };

  type AuthorshipRejectReason =
    | "unsupported_source"
    | "missing_self_identity"
    | "missing_author_identity"
    | "identity_mismatch"
    | "ambiguous_author"
    | "metadata_unparseable";

  type Authorship =
    | { authoredByUser: true; source: AuthorshipSource; proof: AuthorshipProof }
    | {
        authoredByUser: false;
        source: AuthorshipSource;
        reason: AuthorshipRejectReason;
        observed?: AuthorshipIdentity;
      };
  ```
  Decision traces should log `source`/`method`/`reason` and stable non-secret ids; mask or hash raw email addresses if emitted outside local debug output.
  - **gmail:** `true` if `metadata.isSent === true` **or** parsed `metadata.from` equals the **connected-account** email (prefer `documents.accountId` → `integration_credentials.accountLabel` over a global `user.email` — handles work/personal mailboxes).
    - The Gmail proof carries both the method and mailbox context: `accountId`, `accountEmail`, and parsed `fromEmail`. `sent_flag` is accepted even when `fromEmail` is absent because Gmail's sent-label signal comes from the connected mailbox; `from_connected_account` requires an email equality match.
  - **slack:** `true` only with a stable Slack user-id / verified author email == self (display name is not enough).
  - **github:** `true` only with a stable author login/id == a known self GitHub identity; `false` if self GitHub identity is unavailable.
  - **gcal / notion / imessage / uploads / unknown:** `false` in this slice (events/messages describe attendees, organizers, or third-party content, not durable user identity).
  - Answers "authored by the user?", **not** "about the user?" (the latter is LLM territory). `isSent` is necessary-not-sufficient (a sent email can quote inbound text); the prompt keeps "ignore quoted/forwarded prior messages," and stripping quoted history in the Gmail content builder is a later, separate improvement.

### 3a. `proposeFact` (facts.ts) — unbypassable persistence invariant

- **All sources:** `canonicalizeFactKey` **before** dedup/conflict checks (so an alias never forks a fact). Persist under the canonical key; record `originalKey` in `source.meta` when `wasAlias`.
  - Non-document `ok:false` ⇒ **persist as-is** + emit a structured `fact_key_unknown_non_document` trace (visible drift, no breakage to `user`/`cold_start`/`tool_call`).
- **`source.kind === "document"` only:** reject `unknown_key`; reject `classifyDocumentFactKey === "not_writable"`; reject `validateFactValueForKey` failure. (No authorship — `proposeFact` lacks document metadata by design.)
- **Source-agnostic conflict invariant** on `SINGLE_VALUED_KEYS`:
  - Incoming value matches an active value (same `valueSignature`) ⇒ existing dedup skip.
  - Incoming value differs from an active **authoritative** value (active `confirmed`, and `edited` where used as user-truth — never `rejected`/`superseded`):
    - `source.kind === "user"` / `editFact` ⇒ **supersede immediately** (user is authoritative).
    - **autonomous sources** (`document`/`cold_start`/`tool_call`) ⇒ **insert as `proposed` regardless of confidence**, and **do not emit `memory.fact_learned`**. Caps the pile-up at one `confirmed` + N `proposed`; the user adjudicates.
  - `tool_call` is treated as autonomous absent an explicit "direct user instruction" marker (deferred to P2 governed `system.remember`).
- Real `conflict` status / review UI / migration ⇒ **deferred to P2** (SI-4). This slice uses existing statuses only.

### 3b. Workflow gate (`apps/server/src/builtins/workflows/memory-extraction.ts` + helper in memory module)

A diagnostic wrapper, **not** the source of truth — `proposeFact` remains the backstop even if a future caller forgets the gate.

```ts
type DocumentFactGateResult =
  | { ok: true; key: string; value: unknown; meta?: Record<string, unknown>; authorship?: Authorship }
  | { ok: false;
      reason: "unknown_key" | "not_document_writable" | "authorship_required" | "invalid_relationship_key" | "invalid_value";
      originalKey: string; canonicalKey?: string; authorship?: Authorship };
```

- Calls the **same** `canonicalizeFactKey` / `classifyDocumentFactKey` / `validateFactValueForKey` helpers (no logic duplication).
- Adds the one contextual check `proposeFact` can't do: `tierB && !authoredByUser(doc) ⇒ authorship_required`.
- On `ok:false`, increment the workflow's existing `blocked` tally (same path as `proposeFact` returning `null`) and decision-trace the reason. Call `proposeFact` only when the gate passes.
- Inputs: `{ proposal, document: { source, metadata, accountId }, selfIdentity }`. Update `loadDocument` to select `documents.accountId`, then load the connected account label for Gmail (`documents.accountId` → `integration_credentials.accountLabel`) instead of relying only on the global `user.email`. The workflow already loads `doc.metadata` + computes `selfEmail` for team-graph capture; this gate should use the richer per-account identity when available and fall back only when it is not.

## Read-side + live-row convergence (#330 owns it)

The capture gates are not done until new canonical writes surface through the identity read surface and existing authoritative rows use the same keys.

- Update `read_user_context`'s guaranteed identity slice from #332:
  - Fetch canonical storage keys: `employer`, `work_summary`, `job_title`, `bio_summary`, `first_name`, `last_name`, `full_name`, `user_nickname`, `location`.
  - Keep the output DTO names stable (`currentCompany`, `currentWork`, `currentRole`, `currentLocation`) by mapping them from `employer`, `work_summary`, `job_title`, and `location`. API consumers should not need to know the storage-key migration happened.
  - Include a temporary read alias only during the migration window if needed, but the done state is canonical-key-only in storage and canonical-key-first in reads.
- Canonicalize existing live rows once:
  - For every `user_facts` row with an alias key (`current_company`, `company`, `company_name`, `current_role`, `current_work`, `current_location`, `name`, `personal_website`, etc.), rewrite or supersede it to the canonical key before dedup/conflict checks.
  - If an alias row and canonical row have the same `valueSignature`, keep the canonical row and mark the duplicate inactive (`superseded` or rejected via the same reversible governance path used by the purge; choose one implementation path and apply consistently).
  - If an alias row conflicts with an active authoritative canonical row, apply the same single-valued conflict rule: user-authored truth wins; autonomous rows become `proposed`.
  - Verify `current_company="Oliv AI"` still surfaces as `profile.currentCompany === "Oliv AI"` after the migration.

## Data purge (#330 owns it; #331 folded in)

The new gates stop *future* writes only; the 921 live rows keep `read_user_context` hallucinating. #331's purge tooling was built on the **old** narrow classifier and did commit **638 rejected document rows** on dev, but it intentionally kept identity-shaped keys that we now know are third-party leaks. Current dev still has **241 active document rows** (170 confirmed + 71 proposed), including `home_city`, `home_country`, `github_username`, `phone_number`, and `personal_website` pollution. Rebuild cleanup on the new classifier — one definition of "junk", no third drifting copy.

- **Shape (a) — canonicalization failures:** reject document rows whose key fails `canonicalizeFactKey`, including malformed `relationship:*` rows (`relationship:github.com`, display names, domains, bot labels). This must run before classification.
- **Shape (b) — `not_writable` keys:** reject by canonical key alone (`classifyDocumentFactKey === "not_writable"`) — `evoting_*`, `*_insurance_*`, `programming_language`, `starbucks_*`, loyalty rows, `phone_number`, `pref:*`, etc.
- **Shape (c) — leaked Tier B:** re-load each row's source document via `source.id`, re-judge through `authoredByUser`, reject rows that fail attribution. Leave `user`/`cold_start` identity intact after canonicalizing them (`current_company = "Oliv AI"` becomes canonical `employer = "Oliv AI"` and must still surface through `profile.currentCompany`). Canonicalize aliases before judging conflict/purge so legacy `company`/`current_company` rows and canonical `employer` rows compare against the same key.
- **Done criteria:** dry-run → eyeball → `--commit` on dev → re-run the grill-time verification query and confirm **≤ 1 active value per single-valued key** and zero `not_writable` active document rows.

## Scope (out / parked)

- **No `conflict` status / migration / review UI** — P2 governance (SI-4 in `long-term-memory-v1.md`).
- **No global unknown-key enforcement** — `unknown_key` rejection + document write allow-list are `document`-scoped only; `cold_start`/`tool_call` may still write unknown keys with a drift trace. But **known aliases canonicalize globally** in this slice, so cold-start `company`/`job_title`/`location`/`name` writes persist under `employer`/`job_title`/`location`/`full_name` and surface through the read side.
- **No document-derived preferences** (`pref:*` non-document-writable) — inferring durable preferences from email is a separate product problem; writing-style belongs in style/memory extraction with its own confidence + UX.
- **No quoted-history stripping** in the Gmail content builder — a later content-builder improvement; the authorship gate + prompt rule cover this slice.

## Build order

0. **ADR-0079 written** (decisions.md) — deterministic memory-capture gate: two-layer split, canonicalize-vs-reject policy, Tier A/B document allow-list, conservative authorship gate, single-valued hold-`proposed` conflict invariant, purge ownership. Codification of this grill, not a new one.
1. **`@alfred/contracts`**: one canonical fact-key registry (no divergent `FACT_ONTOLOGY` vs `CANONICAL_FACT_KEYS`), `CANONICAL_FACT_PREFIXES`, `FACT_KEY_ALIASES`, `canonicalizeFactKey`. Pure unit tests (alias accepted only when listed; near-miss ⇒ `unknown_key`; `relationship:<bad>` ⇒ `ok:false`; `current_company`/`company_name`/`company` ⇒ `employer`; `current_role` ⇒ `job_title`; `current_location` ⇒ `location`).
2. **`fact-policy.ts`**: `classifyDocumentFactKey`, `validateFactValueForKey`, `SINGLE_VALUED_KEYS`, `authoredByUser`. Unit tests per source and proof shape (gmail `sent_flag`/`from_connected_account`/inbound mismatch; slack/github id vs login/email paths; `gcal`/notion/imessage ⇒ `unsupported_source`).
3. **`proposeFact`**: canonicalize-before-dedup; document unknown/not-writable/value-shape rejection; source-agnostic single-valued conflict → hold-`proposed` + suppress event. Tests on the DB-backed `@alfred/api` suite.
4. **Workflow gate** helper + wire into `memory-extraction.ts` process loop; select `documents.accountId`, load connected-account labels, pass `selfIdentity`, increment `blocked`, and decision-trace structured authorship proof/reject data.
5. **Read-side convergence**: update `user-context.ts` identity guaranteed slice and profile mapping to canonical storage keys while preserving output DTO fields; add DB-backed regression for `employer="Oliv AI"` surfacing as `currentCompany`.
6. **Converge producer prompts** onto the ontology (`extraction.ts`, `cold-start/extract.ts`) — cite the canonical key list; reconcile `company`/`company_name`/`current_company`→`employer`, `current_role`→`job_title`, `current_location`→`location`, `name`→`full_name`, `personal_website`→`personal_site`, etc. Defense-in-depth only.
7. **Canonicalization + purge script** on the new classifier; alias-key live-row convergence → canonicalization-fail → `not_writable` → leaked-Tier-B attribution; dry → `--commit` dev → verify.
8. **Eval** (optional, non-gating): a deterministic-scorer case in the eval lane asserting the gate rejects the known junk shapes and accepts a self-authored identity fact.
