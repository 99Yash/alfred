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

---

## Amendment, 2026-09-12 — a built-in MCP server is a second key space under the same law (#1002)

**What changed.** Alfred pins first-class remote MCP servers: GitHub, Linear, Notion, Sentry, and Polylane. The original ADR left "the MCP per-connection catalog (PRD #540)" undecided. This amendment decides only the part that touches a key space, and leaves the per-connection catalog where it was.

**Decision.** `MCP_BUILT_IN_CATALOG` in `packages/contracts/src/mcp.ts` is a second record whose keys are a key space, and it obeys the same three rules `INTEGRATIONS` obeys. `McpBuiltInProvider` is `keyof typeof MCP_BUILT_IN_CATALOG`. `MCP_BUILT_IN_PROVIDERS` is its key list in record order. `isMcpBuiltInProvider` is the `enumGuard` over that list, and the connect route uses it to narrow a path segment.

**Why it is not the slug space.** A slug names a PRODUCT. A built-in provider names one SERVER, and one product can serve more than one: a read-only resource and a read-write resource are two servers under one brand. The two spaces are one-to-one today, and a third GitHub resource would break that. Each catalog entry therefore carries a `slug` FIELD, which is how a tile borrows brand artwork, and the record's key stays free to name the server.

**Where the halves split.** The split is by audience, not by convenience. `MCP_BUILT_IN_CATALOG` holds what a browser may read: the tile title, the brand slug, and one line of blurb. `BUILT_IN_REGISTRY` in `packages/assistant/src/connections/mcp/built-ins.ts` holds what decides the wire: the endpoint, the canonical resource, the scope baseline, and the protocol pins. The server half is `satisfies Record<McpBuiltInProvider, BuiltInDefinition>`, so an entry in one half with no entry in the other fails to compile. Neither half can ship a provider the other does not know.

**What this costs and what it buys.** The next built-in adds no route, because `GET /api/integrations/mcp/built-ins/:provider/connect` takes the provider from the path, and no web component, because one `McpBuiltInCard` renders every catalog entry. That is the part the key space buys, and it holds.

The entry count is two only when the product is ALREADY a provider entry with brand artwork, which is what the catalog's `slug` field borrows. A product Alfred has never integrated costs more, and Polylane is the first one to pay it: the `MCP_BUILT_IN_CATALOG` entry, the `BUILT_IN_REGISTRY` entry, an `INTEGRATIONS` provider entry for the slug to resolve, and then FOUR web tables, because the web keys its assets and its page prose on the registry and each table is exhaustive by `satisfies` — `BRAND_SVGS` (the bare mark), `BRAND_ICONS` (how that mark is tinted), `INTEGRATION_TILES` (the app-icon coin, which is what an MCP tile actually renders), and `INTEGRATION_PAGE_COPY` (the catalog page). Seven, not four; the first draft of this paragraph said four and was written before any such product existed.

The compiler names all seven, which is the property worth keeping: `slug` is typed `CatalogSlug`, so a slug with no provider entry does not compile, and a tile therefore never falls back to a generic glyph. Three further edits the compiler cannot name: the endpoint constant, the measured scope baseline, and this ADR.

**Two rules the same change locks, recorded here rather than in a new ADR.**

1. **A pinned OAuth client is the exception, not the rule.** Most authorization servers publish a `registration_endpoint`, so Alfred registers its own client under RFC 7591 and pins no credential. `BuiltInDefinition.staticClient` is optional, and GitHub is the one entry that sets it, because its authorization server supports neither dynamic registration nor a URL-based client id (#934). A built-in that pins no client needs no environment variable, so a new first-class server is a code change alone.
2. **A challenge is not a refusal.** The generic add door (#1004) used to answer an authorization challenge by creating no rows. It now creates the connection in `auth_required` and returns its id, and the browser walks that id to `GET /api/integrations/mcp/connections/:id/authorize`. The rule the probe still keeps is narrower and sharper: a URL Alfred REFUSES leaves no rows. The cost is that a user who abandons a consent screen leaves a connection in `auth_required`. Both cards answer that state with "Grant access", pointed at the same door, so the row is visible AND recoverable. It has to be both: the row holds no credential, so `reconnect` cannot repair it, and a card that offered only Reconnect left the owner retyping the URL.
3. **Every consent door drops the live client before it asks.** The three doors differ in how they reach a connection id and in whether they force a consent SCREEN. They do not differ here. The callback reports a successful grant by opening a client, and the connection manager writes the row's status only when it OPENS a generation — a cached one is handed back with no write. A door that left a live client alive would therefore leave a connection reading `auth_required` after a grant it had already redeemed, with a "Grant access" button that repeats the round trip and never clears. The second reason is narrower and older: a session opened under the grant a new one replaces must not outlive it.
