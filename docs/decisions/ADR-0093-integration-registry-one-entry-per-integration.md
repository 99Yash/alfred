# ADR-0093 — One integration registry in `@alfred/contracts`: the slug is the only key, the credential provider is a field, `planned` is a status

**Decision.** Every fact that is _about one integration_ lives in one record, `INTEGRATIONS` in `packages/contracts/src/integrations.ts`, keyed by `IntegrationSlug` and `satisfies Record<IntegrationSlug, IntegrationEntry>`. Every other table keyed by an integration is a projection of that record, an exhaustive sibling keyed by a union the record derives, or a web asset keyed by a brand key the record owns. There is no fourth kind.

Three sub-decisions close the open questions in [the inventory](../plans/integration-registry-inventory.md) section 9:

1. **The web keys on the slug.** The catalog id (`google_gmail`) is deleted. The `google_*` words survive only as brand asset file names. The detail route takes a slug; a loader-local map redirects the six legacy ids for one release.
2. **The credential provider is a registry fact.** It is the value in `integration_credentials.provider` and the route family `/api/integrations/<provider>`. It is derived, not a field: `google` for a `google_oauth` credential, the slug for every other shape (`credentialProviderOf(slug)`), so a slug cannot be paired with another slug's route family and there is no hand-listed provider union. (Amended in PR 1; the first draft made it a field.) The column is typed `$type<CredentialProvider>` with a `CHECK` constraint over the derived list and a parse at the read boundary. The web `IntegrationBackend` union and the assistant `ACCESS_SPECS` list are deleted; both were this field.
3. **Slack and Linear are `status: "planned"` provider entries.** They have a display name and a brand and no `credential` or `passthrough` field. Their `actions` field is typed `readonly []`, so the record cannot give them a tool. The `deferred` and `not_applicable` values of `CredentialShape` and `CoverageDecision` disappear; the entry's `kind` and `status` carry that fact.

Build order and per-package effects are in [the plan](../plans/integration-registry-v1.md).

**Extends ADR-0053** (the connected summary reads `summaryBlurb` off the record). **Extends ADR-0074** (the coverage table is a derivation of `passthrough`). **Does not change ADR-0018** (`mcp` is one `internal` entry; the per-connection MCP catalog stays its own concern).

---

## Why this is its own ADR

PR #941 added `INTEGRATION_DISPLAY_NAMES`. It was the fourth home for an integration's display name. The inventory then found more than 40 tables across five packages keyed by six key spaces: the contracts slug, the web catalog id, the web brand, the credential provider, the web route backend, and three Google-internal keys. Three web tables each had nine rows and each lacked `notion`, `railway`, and `vercel`, so the policy control never rendered on those three pages. None of the three was typed `Record<IntegrationSlug, ...>`, so a missing row compiled.

The repo already has the right pattern in two places: `CREDENTIAL_SHAPE` and `GENERAL_INVOCATION_COVERAGE` are `as const satisfies Record<LoadableIntegrationSlug, ...>` and derive their subset unions by mapped types. The failure was not the pattern. It was that the pattern was applied per table, so each table was exhaustive alone while the set of tables was open. This ADR makes the set closed: the record is the one place a slug is added, and the compiler enumerates the siblings.

## The domain map

- **Identity.** The slug. Fifteen values, spelled once as the keys of the record: `IntegrationSlug` is `keyof typeof INTEGRATIONS` and `INTEGRATION_SLUGS` is its key list in record order. Nothing else identifies an integration, and the tool actions an integration registers are a field on its entry (`INTEGRATION_ACTIONS` is a projection). A source enum (`DOCUMENT_SOURCES`, `OBSERVATION_SOURCES`, `GATHER_SOURCE_SLUGS`) describes the provenance of data and maps _to_ a slug where one exists; it does not join the record.
- **Kind.** `internal` (`system`, `mcp`), `channel` (`imessage`), `provider` (the rest). Only a provider has a brand and a page. Only a live provider has a credential and a passthrough.
- **Authority.** `@alfred/contracts` owns the record because every other package already depends on it and it is browser-safe. The web owns icons, colors, tiles, and page prose. `packages/integrations` owns OAuth mechanics and client factories, and asserts its `providerRegistry` against `CredentialProvider`. The Google scope and feature vocabulary moves to contracts as plain strings, so an entry can name the scopes that prove it is connected.
- **Representation.** `as const` keeps every literal. Subset unions are `SlugsWhere<P>` mapped conditionals. Runtime lists are `filter` over the tuple with a predicate that reads the record, then `enumGuard`.

## The adjudications

**D1 — Slug over catalog id.** The catalog id existed so six Google products could share one route family. The route family is now `credential.provider`, so the id has no job. Keeping it would keep an alias table, and alias tables are where the three missing rows lived.

**D2 — Provider as a field, not a separate concern.** The alternative was a typed column in `packages/db` and a slug-to-provider map in `packages/integrations`. That keeps the only map outside contracts, where the web cannot read it, so the web keeps `PROVIDER_BACKEND` and the duplication survives. One field, read by all three.

**D3 — `planned` status over empty action lists.** An empty list is a convention. A status is a type. With the status, the compiler can prove a planned entry has no credential (the field is absent from the type) and no actions (`actions: readonly []` on the planned entry type). The mention palette and the connect nudge read `status`, not `PROVIDER_BACKEND.has(...)`.

**D4 — A `CHECK` constraint on `provider`.** A new provider then needs a migration. That is the honest cost: a persisted vocabulary changed. `$type` alone is a compile-time claim over a column the database does not enforce.

**D5 — Brand key in the record, asset in the web.** Contracts cannot import SVGs or Lucide. It owns the key so `BRAND_ICONS satisfies Record<IntegrationBrand, ...>` fails to compile when a provider entry has no icon. `web` and `collaborators` become `WebOnlyBrand`.

## What this ADR does not decide

- Per-tool facts (`TOOL_LABELS`, `TOOL_CATEGORIES`, `tool-schemas.ts`), per-client facts (`REST_GATE_CONFIG`, base URLs), and the route handlers. They stay where they are and key on derived unions.
- The Gmail-only event-trigger readiness. Behavior, not a table.
- The MCP per-connection catalog (PRD #540).
