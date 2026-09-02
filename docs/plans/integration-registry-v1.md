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
| A `planned` entry has no actions            | Type fixture: `(typeof INTEGRATION_ACTIONS)[PlannedSlug]` must extend `readonly []`                                                                      |
| A persisted provider string is the union    | `text().$type<CredentialProvider>()` plus a `CHECK` constraint plus a zod parse at the read boundary                                                     |
| A persisted nudge slug is the union         | `chatConnectNudgeSchema.integration` is `z.enum(INTEGRATION_SLUGS)`; a foreign value drops the nudge at replay                                           |
| The type-level doors hold                   | `@ts-expect-error` probes in a `*.type-test.ts` fixture that the contracts test program compiles; `check:type-fixtures` fails a fixture no program reads |
| No new hand-typed slug map                  | Consolidation rule `partial-integration-slug-record` (section 6)                                                                                         |

## 3. The record

File: `packages/contracts/src/integrations.ts`. Browser-safe. Imports only `./tools` (the slug
tuple and `INTEGRATION_ACTIONS`) and `./guards`.

### 3.1 Entry shape

```ts
type IntegrationEntry =
  | InternalEntry // system, mcp
  | ChannelEntry // imessage
  | PlannedEntry // slack, linear
  | LiveEntry; // the ten connectable providers

interface EntryBase {
  displayName: string;
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
      provider: "google";
      /** Consent features the connect route asks for, section 3.3. */
      features: readonly GoogleFeature[];
      /** Connected when an active row holds any one of these. */
      anyOfScopes: readonly GoogleScope[];
    }
  | { shape: "github_app"; provider: "github" }
  | {
      shape: "bearer";
      provider: "notion" | "railway" | "vercel";
      /** How the token arrives. `token_paste` renders a form, not a redirect. */
      connect: "oauth" | "token_paste";
    };
```

`provider` is the value in `integration_credentials.provider` and the route family
`/api/integrations/<provider>/...`. They are one field on purpose. The `CREDENTIAL_SHAPE`
header today argues that the route family and the credential shape are different axes. That
stays true. It does not argue that the route family and the provider are different, and no code
treats them differently. If they diverge, add a field. Do not add a key space.

`CredentialProvider` is derived: the union of every `credential.provider` literal in the
record. Today it is `"google" | "github" | "notion" | "railway" | "vercel"`.

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
| `liveProviders()`                                                       | ordered `readonly LiveEntryWithSlug[]` for the assistant and the web                                             |
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

- `tools.ts` keeps `INTEGRATION_SLUGS` (the id space) and `INTEGRATION_ACTIONS` (per tool, not
  per integration). `INTEGRATION_SLUGS` becomes the flat tuple of fifteen. `LOADABLE_INTEGRATION_SLUGS`
  is derived from the record by `filter`, no longer the primitive the tuple spreads. The record
  cannot both satisfy `Record<IntegrationSlug, ...>` and define the slug list; the tuple is the
  one primitive. `INTEGRATION_DISPLAY_NAMES` moves to the registry file and is re-exported.
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

- `connections/availability.ts`: `ACCESS_SPECS` is deleted. The read maps `liveProviders()` to
  `{ slug, provider, anyOfScopes }`; the non-Google entries contribute an empty scope list.
- `execution/connected-summary.ts`: `SUMMARY_SLUGS` is deleted. The summary iterates
  `liveProviders()` and reads `summaryBlurb` and `identityInSummary`. The eval `BLURB` table in
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

- `INTEGRATION_ACTIONS`, `TOOL_LABELS`, `TOOL_CATEGORIES`, `tool-schemas.ts`: per tool.
- `REST_GATE_CONFIG`, `rest-passthrough.ts` base URLs, `GOOGLE_PASSTHROUGH_BASE_URLS`,
  `AUTHORITY_SCOPES`: per client. Must be `satisfies Record<SupportedRestSlug | ..., T>`.
- The route handlers and the OAuth flows.
- `DOCUMENT_SOURCES`, `OBSERVATION_SOURCES`, `EVENT_SOURCES`, `GATHER_SOURCE_SLUGS`: provenance
  of data, not the integration entity. Where one maps to an integration, the map is
  `satisfies Record<Source, IntegrationSlug | null>` and lives with the source enum.

## 6. Enforcement

1. **Type fixtures.** `packages/contracts/test/type/integrations.type-test.ts`, inside the
   `tsconfig.test.json` program so `check:type-fixtures` sees it, with `@ts-expect-error` probes: an entry without `displayName`; a `planned` entry with a
   `credential`; a `live` entry without `domain`; a `provider` literal outside the union assigned
   to `CredentialProvider`; an `INTEGRATION_ACTIONS` row for a `PlannedSlug` that is non-empty.
   Mutation-test each probe by deleting the guard it protects and reading `TS2578`
   (see lesson [type fixture must mutation-test every binding](../../.lessons/type-fixture-must-mutation-test-every-binding-it-claims.md)).
2. **Consolidation rule** `partial-integration-slug-record`, severity `gate`:
   `/Partial<Record<(Loadable)?IntegrationSlug\b/` and `/new Map<(string|IntegrationSlug),\s*(Loadable)?IntegrationSlug\b/`.
   Fix text: derive from `INTEGRATIONS` in `@alfred/contracts` or make the record exhaustive.
3. **Value-equality tests** in PR 1. The pre-change literal tables are copied into the test file
   as fixtures. The test asserts deep equality with the derived projections. This is the proof
   that PR 1 changes no value.
4. **`check:architecture`.** No new package edge. `contracts` imports nothing new.
5. **`check:web-boundaries`.** The registry file stays free of Node-only imports.

## 7. Migration, in PR order

Each PR is green on `pnpm check`, `check-types`, and the owning package tests. PR 1 changes no
runtime value. PR 2 and PR 3 are independent of each other and both depend on PR 1.

### PR 1 — `contracts`: the record and its projections

- Add `integrations.ts` and `google-scopes.ts`.
- Rewrite `INTEGRATION_DISPLAY_NAMES`, `CREDENTIAL_SHAPE`, `GENERAL_INVOCATION_COVERAGE`,
  `PASSTHROUGH_TRANSPORT`, and the bearer derivations as projections. Keep every export name.
- `chatConnectNudgeSchema.integration` to `z.enum(INTEGRATION_SLUGS)`. Prove that a persisted
  tool call with a foreign nudge slug drops the nudge and keeps the card list intact.
- `packages/integrations/google/oauth.ts` re-exports the moved vocabulary.
- Value-equality tests and the type fixture.
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
- A test that walks `CatalogSlug` and asserts a page, a brand icon, and a connect path (or a
  token form) for every live entry, and no connect path for a planned one.

### PR 4 — delete the transition projections

- Remove `CREDENTIAL_SHAPE`, `GENERAL_INVOCATION_COVERAGE`, `PASSTHROUGH_TRANSPORT`,
  `credentialShapeForSlug`, and `LEGACY_PAGE_IDS` once no consumer reads them.
- Update `docs/reference/shared-helpers.md` and `packages/contracts/AGENTS.md`.

## 8. Down-proofs the PRs must carry

1. **No value drift in PR 1.** The equality tests in section 6 item 3 pass against the copied
   pre-change literals.
2. **A planned slug cannot gain a credential by accident.** The type fixture rejects it.
3. **A live entry cannot ship without an icon.** Remove `notion` from `BRAND_ICONS` on a scratch
   branch and read the compile error in `integration-icons.tsx`.
4. **The three web bugs cannot recur.** `pnpm check` fails on
   `satisfies Partial<Record<IntegrationSlug`.
5. **Persisted rows survive.** A `integration_credentials` row with every current provider value
   passes the `CHECK`. The production probe lists no other value.
6. **A foreign nudge slug is dropped, not thrown.** Test with a NUL-bearing slug string in a
   persisted tool call (ADR-0070 property at the new door).
7. **Legacy URLs land.** `/integrations/google_gmail` redirects to `/integrations/gmail`.
8. **Dependency direction.** `check:architecture` reports no new edge.

## 9. Not in this plan

- The `readiness.ts` Gmail-only event trigger.
- The MCP per-connection catalog (ADR-0018, PRD #540). `mcp` is one `internal` entry.
- Any change to which tools exist, their risk tiers, or their policy defaults.
- The `web` mention row and its brand. It is not an integration and stays a web-only brand.
