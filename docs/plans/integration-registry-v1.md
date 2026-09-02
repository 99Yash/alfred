# Integration registry v1 — one entry per integration, the slug is the only key

> **Status.** Design, 2026-09-02. Not started. Follows the
> [inventory](./integration-registry-inventory.md). The three decisions in inventory section 9
> are locked: the web keys on the slug; the credential provider is a registry field; Slack and
> Linear carry a `planned` status. [ADR-0093](../decisions/ADR-0093-integration-registry-one-entry-per-integration.md)
> records the decision. This plan is the build order.

## 1. The obligation

One integration is one domain entity. Today its facts live in more than 40 tables across five
packages, keyed by six key spaces. Three tables were missing rows until PR `303ced58` closed
them in the web app. Nothing structural stops the next gap.

After this plan, one record in `@alfred/contracts` holds every fact that is **per integration**.
Every other table that is keyed by an integration is one of three things:

1. a **projection** of the record, derived in code, never hand-typed;
2. an **exhaustive sibling** keyed by a slug union that the record derives, so a missing row is a
   compile error; or
3. an **asset** the web owns, keyed by a brand key the record owns.

There is no fourth kind. A new integration is one new entry, then the compiler lists every
sibling that needs a row.

## 2. The type-safety bar

Every rule below is a compile error or a `pnpm check` gate, not a convention.

| Rule                                        | Mechanism                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every slug has one entry                    | `INTEGRATIONS satisfies Record<IntegrationSlug, IntegrationEntry>`                                                                                       |
| Every entry keeps its literal facts         | `as const` on the record, so `INTEGRATIONS.github.credential.shape` is the literal `"github_app"`                                                        |
| Every subset union is derived, never listed | Mapped conditional types over the record, the pattern `BearerProvider` uses today                                                                        |
| Every runtime list matches its union        | Built by `filter` over `INTEGRATION_SLUGS` with a predicate that reads the record; `enumGuard` over that list                                            |
| Every sibling table is exhaustive           | `satisfies Record<<DerivedSlugUnion>, T>`; `Partial<Record<...Slug` is a consolidation gate                                                              |
| A `planned` entry has no actions            | `PlannedIntegrationEntry.actions` is `readonly []`; the record entry is checked at construction                                                          |
| A persisted provider string is the union    | `text().$type<CredentialProvider>()` plus a `CHECK` constraint plus a zod parse at the read boundary                                                     |
| A persisted nudge slug is the union         | `chatConnectNudgeSchema.integration` is `z.enum(INTEGRATION_SLUGS)`; a foreign value drops the nudge at replay                                           |
| No new hand-typed slug map                  | Consolidation rule `partial-integration-slug-record` (section 6)                                                                                         |

## 3. The record

Folder: `packages/contracts/src/integrations/`, four files: `types.ts` (entry shapes),
`registry.ts` (the record), `slugs.ts` (derived unions and lists), `projections.ts` (slug-keyed
tables). Browser-safe. Imports only `../google-scopes` and `../guards`. The record's keys are
the slug space (section 4); `./tools` imports it, not the reverse.

_Deviation recorded in PR 1:_ the record also carries `actions`, the tool actions an
integration registers. `INTEGRATION_ACTIONS` in `tools.ts` is a projection of it, so
`ActionSlug` and `ToolName` still derive as before, and a planned entry's `actions: readonly []`
is part of its type. The plan's type fixture for that row is then unnecessary.

### 3.1 Entry shape

```ts
type IntegrationEntry =
  | InternalEntry // system, mcp
  | ChannelEntry // imessage
  | PlannedEntry // slack, linear
  | LiveEntry; // the ten connectable providers

interface EntryBase {
  displayName: string;
  actions: readonly string[]; // `readonly []` on a planned entry
}

interface InternalEntry extends EntryBase {
  kind: "internal";
}

interface ChannelEntry extends EntryBase {
  kind: "channel";
}

interface PlannedEntry extends EntryBase {
  kind: "provider";
  status: "planned";
  brand: string; // web asset key, section 3.4
}

interface LiveEntry extends EntryBase {
  kind: "provider";
  status: "live";
  brand: string;
  credential: CredentialSpec;
  passthrough: PassthroughSpec;
  /** One line the model reads in the connected summary (ADR-0053). */
  summaryBlurb: string;
  /** Append the connected account identity to the summary line (ADR-0071 F2). */
  identityInSummary?: true;
  /** Host for favicons and evidence grouping, e.g. `github.com`. */
  domain: string;
}
```

`kind` decides the shape. `status` exists only on `provider`. This replaces the three
independent enums `CredentialShape` (`deferred`, `not_applicable`), `CoverageDecision`
(`deferred`, `not_applicable`), and the implicit "empty action list" convention with one fact:
a `planned` or non-provider entry has no credential and no passthrough because its type has no
such field.

### 3.2 Credential spec

```ts
type CredentialSpec =
  | {
      shape: "google_oauth";
      /** Consent features the connect route asks for, section 3.3. */
      features: readonly GoogleFeature[];
      /** Connected when an active row holds any one of these. */
      anyOfScopes: readonly GoogleScope[];
    }
  | { shape: "github_app" }
  | {
      shape: "bearer";
      /** How the token arrives. `token_paste` renders a form, not a redirect. */
      connect: "oauth" | "token_paste";
    };
```

The credential provider is the value in `integration_credentials.provider` and the route family
`/api/integrations/<provider>/...`. _Deviation recorded in PR 1:_ it is not a field. It is
`"google"` for a `google_oauth` credential and the slug for every other shape, read with
`credentialProviderOf(slug)`. A `provider` field would need a hand-listed union
(`"notion" | "railway" | "vercel"`) and would let a `notion` entry name `vercel` as its route
family; the derivation makes both impossible. If a provider ever differs from its slug, add a
field then. Do not add a key space.

`CredentialProvider` is `"google" | GithubAppSlug | BearerSlug`. Today it is
`"google" | "github" | "notion" | "railway" | "vercel"`.

### 3.2b Passthrough spec

```ts
type PassthroughSpec = { transport: "rest" } | { transport: "graphql" } | null;
```

`null` is a live provider with no general-invocation tier (ADR-0074). Every live provider today
has one, so the `deferred` and `not_applicable` coverage values disappear: a planned entry and a
channel have no `passthrough` field at all. `PASSTHROUGH_TOOL_NAMES` derives from the non-null
entries, unchanged in value.

### 3.3 Google vocabulary moves to contracts

`GOOGLE_FEATURE_SCOPES`, the nine scope URL constants, and `GoogleFeature` are plain strings.
They move to `packages/contracts/src/google-scopes.ts`. `@alfred/integrations/google` re-exports
them, so no consumer changes an import. The OAuth mechanics (`scopesForFeatures`, the client,
the token refresh) stay in `packages/integrations`.

`GoogleScope` becomes a union of the nine URL literals. `anyOfScopes` and `features` on the
Gmail and Calendar entries are then checked against the real vocabulary, and the hand-written
`?features=briefing,triage,reply_draft` string in `detail-header.tsx` becomes a join over a typed
array.

### 3.4 Brand is a key, the asset stays in the web app

`brand` on a `provider` entry is a string literal. `IntegrationBrandKey` is the derived union of
those literals. The web declares `BRAND_ICONS satisfies Record<IntegrationBrand, BrandIconMeta>`
where

```ts
type IntegrationBrand = IntegrationBrandKey | WebOnlyBrand;
type WebOnlyBrand = "web" | "collaborators";
```

So a new provider entry without an icon is a compile error in `integration-icons.tsx`, and the
two non-integration brands stop pretending to be integrations. The Google brands keep their
`google_*` file names. That is the only place `google_gmail` survives.

### 3.5 Derived exports

All derived from `INTEGRATIONS`; none hand-typed.

| Export                                                                  | Derivation                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `LiveProviderSlug`                                                      | entries with `kind: "provider"`, `status: "live"`                                                                |
| `PlannedSlug`                                                           | `status: "planned"`                                                                                              |
| `CatalogSlug`                                                           | `LiveProviderSlug \| PlannedSlug`; the slugs that have a page                                                    |
| `LoadableIntegrationSlug`                                               | `kind !== "internal"`; same members as today                                                                     |
| `CredentialProvider`                                                    | union of `credential.provider`                                                                                   |
| `GoogleSlug`, `BearerSlug`, `GithubAppSlug`                             | by `credential.shape`                                                                                            |
| `SupportedPassthroughSlug`, `SupportedRestSlug`, `SupportedGraphqlSlug` | by `passthrough`                                                                                                 |
| `INTEGRATION_DISPLAY_NAMES`                                             | `Record<IntegrationSlug, string>` projection, same values                                                        |
| `CREDENTIAL_SHAPE`                                                      | projection; `planned` and `channel` read `"deferred"` and `"not_applicable"` for the transition, deleted in PR 4 |
| `GENERAL_INVOCATION_COVERAGE`, `PASSTHROUGH_TRANSPORT`                  | projections, deleted in PR 4                                                                                     |
| `LIVE_PROVIDERS`                                                        | ordered `readonly LiveProviderEntry[]` for the assistant and the web                                             |
| `integrationEntry(slug)`                                                | typed index, `INTEGRATIONS[slug]`                                                                                |
| `isCatalogSlug`, `isLiveProviderSlug`, `isCredentialProvider`           | `enumGuard` over the derived lists                                                                               |

The mapped-type shape, once, so the pattern is fixed:

```ts
type SlugsWhere<P> = {
  [K in IntegrationSlug]: (typeof INTEGRATIONS)[K] extends P ? K : never;
}[IntegrationSlug];

type LiveProviderSlug = SlugsWhere<{ kind: "provider"; status: "live" }>;
type BearerSlug = SlugsWhere<{ credential: { shape: "bearer" } }>;
```

## 4. What each package reads after the change

### `packages/contracts`

- `integrations/registry.ts` owns the record, `IntegrationSlug`, `INTEGRATION_SLUGS`, and
  `isIntegrationSlug`. _Deviation recorded in PR 1:_ there is no slug tuple. `IntegrationSlug` is
  `keyof typeof INTEGRATIONS` and `INTEGRATION_SLUGS` is `Object.keys` of the record, in record
  order, so a slug is spelled once. The record `satisfies Record<string, IntegrationEntry>`; the
  exhaustiveness the plan wanted from `Record<IntegrationSlug, …>` is then trivial, because the
  record IS the slug space. `LOADABLE_INTEGRATION_SLUGS` is derived by `filter`.
  `INTEGRATION_DISPLAY_NAMES` and `INTEGRATION_ACTIONS` are projections in
  `integrations/projections.ts`; `tools.ts` imports both. The root exports of `@alfred/contracts`
  are unchanged.
- `credentials.ts` keeps `credentialRowSchema` and `rowToCredentialWire`. `CREDENTIAL_SHAPE`,
  `BearerProvider`, `BEARER_PROVIDER_SLUGS`, `isBearerProvider` become re-exports of registry
  derivations. `credentialShapeForSlug` stays for the one dynamic caller and reads the registry.
- `passthrough.ts` keeps the preference-key helpers. The coverage and transport tables become
  derivations. `PASSTHROUGH_TOOL_NAMES` is unchanged in value.
- `chat.ts`: `chatConnectNudgeSchema.integration` becomes `z.enum(INTEGRATION_SLUGS)`.
- `integration-availability.ts`: `ProviderAvailability` keys on `CredentialProvider`, not
  `string`.

### `packages/integrations`

- `google/oauth.ts` imports the scope vocabulary from contracts and re-exports it.
- `shared/credentials.ts` parses `provider` from the row with `isCredentialProvider` at the read
  boundary and narrows its signatures to `BearerSlug`, which it already does through
  `BearerProvider`.
- `providerRegistry` gains `satisfies Record<CredentialProvider, ProviderFactory>`. A provider
  in the registry without a client factory is then a compile error. This is the one place a
  `packages/integrations` fact is checked against the contracts record, and the edge direction
  (`integrations -> contracts`) already exists in the baseline.

### `packages/db`

- `integration_credentials.provider` becomes `text("provider").$type<CredentialProvider>()`.
- One migration adds `CHECK (provider IN (...))` over the derived list. The migration is
  generated after a `SELECT DISTINCT provider` probe against production is recorded in the PR
  body. The column comment that names `slack` and `linear` is corrected.
- Trade: a new credential provider needs a migration. That is correct. A persisted vocabulary
  changed.

### `packages/assistant`

- `connections/availability.ts`: `ACCESS_SPECS` is deleted. The read maps `LIVE_PROVIDERS` to
  `{ slug, provider, anyOfScopes }`; the non-Google entries contribute an empty scope list.
- `execution/connected-summary.ts`: `SUMMARY_SLUGS` is deleted. The summary iterates
  `LIVE_PROVIDERS` and reads `summaryBlurb` and `identityInSummary`. The eval `BLURB` table in
  `evals/tool-selection-bloat.eval.ts` reads the same field.
- `automation/recovery-navigation.ts`: `GOOGLE_INTEGRATIONS` becomes
  `integrationEntry(slug).credential.shape === "google_oauth"` behind `isLiveProviderSlug`.
- `tool-runtime/internal/tools/*.ts`: each tool's `availability.credential.provider` is typed
  `CredentialProvider`. No value changes.
- `readiness.ts` stays Gmail-only. That is behavior, not a table. Out of scope.

### `packages/http`

- The five `*-routes.ts` files keep their handlers. Each route prefix is asserted against the
  registry with one line: `const PROVIDER = "notion" satisfies CredentialProvider`.
- `tool-tiers.ts` keys on `LoadableIntegrationSlug`, unchanged.

### `packages/sync`

- `mutators/policy.ts` keys on `LoadableIntegrationSlug`, unchanged.

### `apps/web`

The slug is the key. The catalog id is deleted.

- `lib/integrations/integrations.ts`: `INTEGRATION_PROVIDERS` becomes
  `INTEGRATION_PAGES satisfies Record<CatalogSlug, IntegrationPageCopy>`, where
  `IntegrationPageCopy` holds only web-only prose: `description`, `category`, `capabilities`,
  `trust`, `overview`, `related`. `IntegrationProvider` becomes
  `IntegrationPage = { slug } & ProviderEntry & IntegrationPageCopy`, built by one `map` over
  `CatalogSlug`. `name` is `displayName`. `status: "available" | "soon"` derives from `status`.
- Deleted: `CATALOG_ID_BY_SLUG`, `PROVIDER_ID_TO_SLUG`, `integrationSlugForProvider`,
  `PROVIDER_REQUIRED_SCOPES`, `PROVIDER_BACKEND`, `IntegrationBackend`, `CONNECT_PATHS`,
  `POPULAR_INTEGRATIONS` prose fields that the registry holds, the `brand` and `label` fields of
  the integration rows in `MENTION_OPTIONS`, the per-provider `faviconDomain` literals in
  `evidence.ts`.
- `connectPathFor(slug: LiveProviderSlug): string` in `lib/integrations`:
  `/api/integrations/${provider}/connect` plus `?features=` joined from the entry for Google.
  `detail-header.tsx` branches on `credential.connect === "token_paste"`, not on
  `slug === "railway"`.
- `use-integration-status.ts`: the two `switch (backend)` blocks switch on `CredentialProvider`.
  They stay, because the Eden client paths are mechanics. `matchByCredentialShape` reads
  `entry.credential.shape`; `matchByScopes` reads `entry.credential.anyOfScopes`.
- Route `integrations.$provider.tsx` becomes `integrations.$slug.tsx`. A `LEGACY_PAGE_IDS`
  map with the six `google_*` ids lives in that route's loader only and redirects. It is the last
  home of the catalog id and is deleted one release later.
- `mention-connection.ts`: `classifyMentionValue` returns `unavailable` for `PlannedSlug`,
  `internal` for a non-slug, otherwise reads the status map.
- `onboarding-flow.tsx`: `POPULAR_INTEGRATIONS` keeps its order and its short web-only
  `description`. `name`, `brand`, and `bundledWithGoogle` (`shape === "google_oauth"`) derive.
- `integration-icons.tsx`: `BRAND_ICONS satisfies Record<IntegrationBrand, BrandIconMeta>`,
  section 3.4. `BRAND_ACCENT` becomes `satisfies Partial<Record<IntegrationBrand, string>>`.
  A partial record is allowed here because it is keyed by brand, not by slug, and an absent brand
  falls back on purpose.
- `passthrough-section.tsx`: `PASSTHROUGH_META` is already exhaustive over
  `SupportedPassthroughSlug`. Unchanged.
- `source-meta.tsx`, `tool-icon.tsx`, `provider-policy.tsx`: the PR `303ced58` shape stays.
  `brandForIntegration` reads `INTEGRATIONS[slug]`.

## 5. What stays outside the registry

Per tool, per client, or per scope. Each is keyed by a derived union, so it is exhaustive, but
none of it is a fact about the integration entity.

- `TOOL_LABELS`, `TOOL_CATEGORIES`, `tool-schemas.ts`: per tool. (`INTEGRATION_ACTIONS` is a
  projection of the entries' `actions`; see section 3.)
- `REST_GATE_CONFIG`, `rest-passthrough.ts` base URLs, `GOOGLE_PASSTHROUGH_BASE_URLS`,
  `AUTHORITY_SCOPES`: per client. Must be `satisfies Record<SupportedRestSlug | ..., T>`.
- The route handlers and the OAuth flows.
- `DOCUMENT_SOURCES`, `OBSERVATION_SOURCES`, `EVENT_SOURCES`, `GATHER_SOURCE_SLUGS`: provenance
  of data, not the integration entity. Where one maps to an integration, the map is
  `satisfies Record<Source, IntegrationSlug | null>` and lives with the source enum.

## 6. Enforcement

1. **The types.** No test fixture (root `CLAUDE.md`: no tests for a feature). The entry types
   carry the doors: `displayName` and `domain` are required fields, a planned entry has no
   `credential` field and its `actions` is `readonly []`, and the credential provider is derived
   from the slug so it cannot be mis-paired.
2. **Consolidation rule** `partial-integration-slug-record`, severity `gate`: a `Partial<Record<`
   keyed by a union the registry derives (every `*IntegrationSlug`, `LiveProviderSlug`,
   `CatalogSlug`, `BearerSlug`, `Supported*Slug`, `CredentialProvider`, the two transition
   aliases), and a literal `new Map<…>([` whose key or value is one. A Map filled at request
   time is a lookup index and is not matched; `GatherSourceSlug` is not an integration slug and
   is not matched. The check's self-test reads `slugs.ts` and fails when an exported union there
   escapes the rule's alternation, so the list cannot lag the registry.
   Fix text: derive from `INTEGRATIONS` in `@alfred/contracts` or make the record exhaustive.
   One sanctioned exception, marked `// drift-ok` on its line: `IntegrationRules` in `tools.ts`,
   a user's per-integration policy overrides, where an absent slug means the default mode.
3. **No value drift in PR 1.** Proved once, at review time, with a scratch probe that
   `deepEqual`s every exported table and list against the pre-change literal modules copied
   from `main` at `0292be13` (`INTEGRATION_SLUGS`, `INTEGRATION_ACTIONS`, `TOOL_NAMES`,
   `CREDENTIAL_SHAPE`, the passthrough tables, `CREDENTIAL_PROVIDERS`, `LIVE_PROVIDERS`). The
   probe passed and was deleted. No test file carries that comparison.
4. **`check:architecture`.** No new package edge. `contracts` imports nothing new.
5. **`check:web-boundaries`.** The registry folder stays free of Node-only imports.

## 7. Migration, in PR order

Each PR is green on `pnpm check`, `check-types`, and the owning package tests. PR 1 changes no
runtime value. PR 2 and PR 3 are independent of each other and both depend on PR 1.

### PR 1 — `contracts`: the record and its projections

- Add `integrations.ts` and `google-scopes.ts`.
- Rewrite `INTEGRATION_DISPLAY_NAMES`, `CREDENTIAL_SHAPE`, `GENERAL_INVOCATION_COVERAGE`,
  `PASSTHROUGH_TRANSPORT`, and the bearer derivations as projections. Keep every export name.
- `chatConnectNudgeSchema.integration` to `z.enum(INTEGRATION_SLUGS)`. A foreign slug reads as
  absent at all three doors: the sync model (`.nullable().optional().catch(null)`), the run-state
  checkpoint (`.optional().catch(undefined)`), and the live `chat.tool` frame
  (`.optional().catch(undefined)`, because `parseEventFrame` drops a whole frame on a payload
  failure and the retraction must land).
- `packages/integrations/google/oauth.ts` re-exports the moved vocabulary.
- Consolidation rule.

### PR 2 — server: the record is the only source of provider facts

- `ACCESS_SPECS`, `SUMMARY_SLUGS`, eval `BLURB`, `GOOGLE_INTEGRATIONS` derive.
- `providerRegistry satisfies Record<CredentialProvider, ProviderFactory>`.
- `ProviderAvailability` and tool `availability.credential.provider` typed.
- Route prefix assertions in `packages/http`.
- DB `$type` and the `CHECK` migration, with the production probe in the PR body.

### PR 3 — web: the slug is the key

- `INTEGRATION_PAGES`, `IntegrationPage`, `connectPathFor`, `IntegrationBrand` split.
- Delete the tables listed in section 4.
- Route rename with the legacy redirect.
- Onboarding, mentions, evidence, detail header derive.
- Behavior change to record in the PR body: `CONNECT_PATHS` had no entry for `drive`, `docs`,
  `sheets`, `slides`, so their detail pages had no connect action. Their registry entries carry
  `features` (added in PR 1, unread until now), so `connectPathFor` makes them connectable.
- A test that walks `CatalogSlug` and asserts a page, a brand icon, and a connect path (or a
  token form) for every live entry, and no connect path for a planned one.

### PR 4 — delete the transition projections

- Remove `CREDENTIAL_SHAPE`, `GENERAL_INVOCATION_COVERAGE`, `PASSTHROUGH_TRANSPORT`,
  `credentialShapeForSlug`, the aliases `BearerProvider` and `SupportedIntegrationSlug`, and
  `LEGACY_PAGE_IDS` once no consumer reads them. Each carries `@deprecated` from PR 1.
- Repoint the importers of the Google scope vocabulary (`smoke-boss.ts`, `smoke-google.ts`,
  `automation/readiness.ts`, `http/test/workflows/revisions.test.ts`) to `@alfred/contracts` and
  delete the re-export block in `google/oauth.ts`. Until then the scopes have two import doors.
- Update `docs/reference/shared-helpers.md` and `packages/contracts/AGENTS.md`.

## 8. Down-proofs the PRs must carry

1. **No value drift in PR 1.** A scratch probe compared every table against the pre-change
   literals and passed (section 6 item 3).
2. **A planned slug cannot gain a credential by accident.** `PlannedIntegrationEntry` has no
   `credential` field.
3. **A live entry cannot ship without an icon.** Remove `notion` from `BRAND_ICONS` on a scratch
   branch and read the compile error in `integration-icons.tsx`.
4. **The three web bugs cannot recur.** `pnpm check` fails on
   `satisfies Partial<Record<IntegrationSlug`.
5. **Persisted rows survive.** A `integration_credentials` row with every current provider value
   passes the `CHECK`. The production probe lists no other value.
6. **A foreign nudge slug is dropped, not thrown.** The `catch` on each of the three doors
   (section 7, PR 1) is the mechanism; there is no test.
7. **Legacy URLs land.** `/integrations/google_gmail` redirects to `/integrations/gmail`.
8. **Dependency direction.** `check:architecture` reports no new edge.

## 9. Not in this plan

- The `readiness.ts` Gmail-only event trigger.
- The MCP per-connection catalog (ADR-0018, PRD #540). `mcp` is one `internal` entry.
- Any change to which tools exist, their risk tiers, or their policy defaults.
- The `web` mention row and its brand. It is not an integration and stays a web-only brand.
