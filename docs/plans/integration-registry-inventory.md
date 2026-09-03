# Integration registry — inventory of every per-integration record

> Status: inventory, 2026-09-02. Not a design. The design comes after this list is agreed.
> Trigger: PR #941 added `INTEGRATION_DISPLAY_NAMES` in `contracts/tools.ts`. That made the
> fourth home for an integration's display name. This document lists every place in the repo
> that holds data or behavior keyed by an integration, so one registry can own them.

## 0. Status of the items this inventory found

| Item | State |
| --- | --- |
| Display name from `humanizeSlug` at the slug-keyed label sites (section 4, rows 3 and 4) | Closed in PR #941. Every slug-keyed label reads `INTEGRATION_DISPLAY_NAMES`. |
| Three web tables with no `notion`, `railway`, `vercel` rows (section 6, item 2) | Closed. One table, `CATALOG_ID_BY_SLUG` in `apps/web/src/lib/integrations/integrations.ts`, is `satisfies Record<IntegrationSlug, ...>`. The brand, the policy control, and the briefing glyph derive from it. |
| Two display-name homes remain: the contracts map and the web catalog `name` | Open. The registry design closes it. |
| `chatConnectNudge.integration` is `z.string()` (section 6, item 7) | Closed in PR #944. It is `z.enum(INTEGRATION_SLUGS)` with a catch at each of its three persisted doors. |
| The registry design (sections 7 to 9) | Decided in ADR-0093 and built in `integration-registry-v1.md`. PR 1 (contracts record) merged as #944. PR 2 (server) open as #945; PR 3 (web) and PR 4 (delete the transition projections) follow. |

## 1. The obligation

One integration is one domain entity. Its slug, display name, brand, credential shape, OAuth
route family, scopes, tool actions, policy default, passthrough coverage, connect copy, and
failure copy are facts about that one entity. Today those facts live in more than 40 tables
across five packages, keyed by at least six different key spaces. Adding an integration touches
every table, and nothing forces the edits to agree. Three tables are already missing rows.

## 2. Key spaces in play

| Key space | Values | Owner |
| --- | --- | --- |
| **slug** (`IntegrationSlug`) | `system`, `mcp`, `gmail`, `calendar`, `drive`, `docs`, `sheets`, `slides`, `slack`, `linear`, `github`, `notion`, `railway`, `vercel`, `imessage` | `packages/contracts/src/tools.ts:33` |
| **web catalog id** | `google_gmail`, `google_calendar`, `google_drive`, `google_docs`, `google_sheets`, `google_slides`, plus slugs for the rest | `apps/web/src/lib/integrations/integrations.ts:40` |
| **brand** (`IntegrationBrand`) | Same words as catalog ids, plus `web`, `collaborators`; no `system`, `mcp`, `imessage` | `apps/web/src/lib/integrations/integration-icons.tsx:90` |
| **credential provider** | `google`, `github`, `notion`, `railway`, `vercel` (untyped `text` column) | `packages/db/src/schema/integrations.ts:60` |
| **web backend** (`IntegrationBackend`) | Route family, same five values as provider | `integrations.ts:391` |
| **Google feature / service / authority** | `briefing`, `triage`, `reply_draft`, `calendar`, ... / six services / read-write split | `packages/integrations/src/google/{oauth,http,client}.ts` |

Adjacent enums that reuse the same words but are **not** integrations: `DOCUMENT_SOURCES`,
`OBSERVATION_SOURCES`, `EVENT_SOURCES`, `GATHER_SOURCE_SLUGS`, `AuthorshipSource`,
`StyleChannel`, `TRACKER_SENDER_PATTERNS`, `BOT_SLUGS`. See section 6.

## 3. Data tables keyed by integration

### packages/contracts

| Site | Key | Holds |
| --- | --- | --- |
| `tools.ts:7-34` `LOADABLE_INTEGRATION_SLUGS`, `INTEGRATION_SLUGS` | slug | The slug universe |
| `tools.ts:41-57` `INTEGRATION_DISPLAY_NAMES` | slug | Display name (PR #941) |
| `tools.ts:65-127` `INTEGRATION_ACTIONS` | slug | Action list per integration |
| `tools.ts:212-233` `IntegrationRule`, `resolveIntegrationMode` | slug | Policy mode and per-tool overrides |
| `tools.ts:347-708` `TOOL_LABELS` | tool name | Running, done, and title copy per tool |
| `tools.ts:727-812` `TOOL_CATEGORIES` | tool name | `source`, `action`, `system` |
| `credentials.ts:57-71` `CREDENTIAL_SHAPE` | loadable slug | `google_oauth`, `github_app`, `bearer`, `deferred`, `not_applicable` |
| `credentials.ts:75-95` `BEARER_PROVIDER_SLUGS`, `credentialShapeForSlug` | slug | Derived bearer set |
| `passthrough.ts:46-60` `GENERAL_INVOCATION_COVERAGE` | loadable slug | `supported`, `deferred`, `not_applicable` |
| `passthrough.ts:89-100` `PASSTHROUGH_TRANSPORT` | supported slug | `rest` or `graphql` |
| `passthrough.ts:135-171` `PASSTHROUGH_TOOL_NAMES`, `passthroughPreferenceKey` | supported slug | Per-slug feature-flag key |
| `integration-availability.ts:5-40` | slug, provider | Health snapshot shape, `ToolUnavailabilityCode` |
| `app-errors/index.ts` | slug | Four parametrized failure codes, `Fix.integration`, `railway_credential_required` |
| `chat.ts:63-81` `chatConnectNudgeSchema` | slug as `z.string()` | Connect nudge payload |
| `mentions.ts:1-20` | slug | `@slug` mention parser |
| `tool-schemas.ts` | tool name (by prefix) | Per-tool input schemas |

### packages/integrations

| Site | Key | Holds |
| --- | --- | --- |
| `integrations.ts:58-64` `providerRegistry` | provider | Client factory per provider |
| `shared/credentials.ts` | bearer provider | Bearer credential CRUD |
| `shared/provider-client.ts` | provider | `baseUrl`, `retry`, `bodyPolicy` |
| `shared/rest-passthrough.ts:60-79` | supported REST slug | Pinned base URL, headers, fixed query |
| `google/oauth.ts:71-140` `GOOGLE_FEATURE_SCOPES`, `scopesForFeatures` | Google feature | Scope lists per feature |
| `google/http.ts:21` `GoogleService` | Google service | Host routing |
| `google/passthrough.ts:20-27` `GOOGLE_PASSTHROUGH_BASE_URLS` | Google service | Passthrough base URL |
| `google/client.ts:72-91` `AUTHORITY_SCOPES` | Google authority | Scope set per authority |
| `github/{rest,app,client,credentials}.ts`, `notion/{oauth,client}.ts`, `vercel/{oauth,client,credential}.ts`, `railway/client.ts` | provider | API bases, OAuth URLs, install URLs, `provider:` literals |

### packages/assistant

| Site | Key | Holds |
| --- | --- | --- |
| `tool-runtime/builtin-tools.ts:11-52` | module per integration | Boot registration order |
| `tool-runtime/internal/tools/*.ts` | slug | `integration`, risk tier, `availability.credential { provider, anyOfScopes }` per tool |
| `tool-runtime/internal/registry.ts:356-425` | slug | Availability gates; message uses `humanizeSlug` |
| `tool-runtime/internal/result-routing.ts` `connectActionFor` | unavailability code | `connect` or `reconnect` |
| `connections/availability.ts:24-45` `ACCESS_SPECS` | loadable slug | **The only slug-to-provider map** plus scope probe; `slack`, `linear`, `imessage` absent |
| `execution/connected-summary.ts:24-120` `SUMMARY_SLUGS` | loadable slug | Model-facing blurb per slug |
| `evals/tool-selection-bloat.eval.ts:50-73` `BLURB` | loadable slug | Duplicate of the blurbs above |
| `tool-runtime/internal/tools/passthrough/config.ts:47-110` `REST_GATE_CONFIG` | supported REST slug | Allow and deny lists per provider |
| `automation/recovery-navigation.ts:4-25` `GOOGLE_INTEGRATIONS` | slug set | Which slugs use the Google re-consent flow |
| `automation/readiness.ts:103-180` | slug | Gmail-only readiness with `providers.get("google")` hardcoded |

### packages/db, packages/http, packages/env, packages/sync

| Site | Key | Holds |
| --- | --- | --- |
| `db/src/schema/integrations.ts:60-102` `integration_credentials.provider` | provider (untyped text) | Credential rows; `installation_id` is GitHub-only |
| `db/src/schema/action-policies.ts:63` | slug cast over text | Per-integration policy rows |
| `db/src/schema/workflows.ts:128,295` | slug, event source | `allowed_integrations`, `trigger.source` |
| `http/src/connections/{google,github,notion,railway,vercel}-routes.ts` | provider | Route prefix, connect, callback, credentials, delete; Railway is token paste, not OAuth |
| `http/src/tool-tiers.ts` | loadable slug | Tier counts per slug |
| `env/src/server.ts:234-284` | provider | OAuth client env vars per provider |
| `sync/src/mutators/policy.ts:8-23` | loadable slug | `policySetIntegrationMode` |
| `sync/src/mutators/workflows.ts:12` `AUTHORABLE_EVENT_SOURCES` | event source | `["gmail"]` |

### apps/web

| Site | Key | Holds |
| --- | --- | --- |
| `lib/integrations/integrations.ts:40-293` `INTEGRATION_PROVIDERS` | catalog id | name, description, status, category, brand, actionLabel, capabilities, trust, overview, related ids |
| `integrations.ts:303-330` `SHORT_SLUG_ALIASES`, `PROVIDER_ID_TO_SLUG` | slug to catalog id | Alias table, six Google rows |
| `integrations.ts:355-374` `PROVIDER_REQUIRED_SCOPES` | catalog id | Required scopes per Google provider |
| `integrations.ts:391-404` `PROVIDER_BACKEND` | catalog id | Route family |
| `lib/integrations/integration-icons.tsx:32-212` `BRAND_SVGS`, `BRAND_ICONS`, `BRAND_ACCENT`, `INTEGRATION_TILES` | brand | SVG paths, colors, hero glow, tile component |
| `lib/integrations/integration-tile-components.tsx` | brand | Twelve tile components |
| `lib/integrations/use-integration-status.ts:80-235` | backend | One credential hook per backend; `switch (backend)` for routes |
| `routes/-chat/mention-options.ts:12-22` | slug plus `web`, `memory`, `notes` | Mention palette rows |
| `routes/-chat/connect-nudges.ts:19-101` | slug to catalog id | Nudge copy and CTA |
| `routes/-chat/tool-call-presentation.ts:88-145` | slug to catalog id | Brand and labels per tool call; `web` special case |
| `routes/-chat/evidence.ts:213-460` | tool name | Evidence renderers, `faviconDomain` per provider |
| `routes/-chat/conversation-helpers.ts:100-120` | brand | Canned follow-ups per brand |
| `routes/-chat/rail/use-inbox.ts:259-269` `brandFor` | email domain | Domain to brand |
| `components/approvals/tool-icon.tsx:11-24` `SLUG_TO_BRAND` | slug to brand | Nine rows; `notion`, `railway`, `vercel` **missing** |
| `components/approvals/card-spec.ts:16-63` `TITLE_OVERRIDES` | tool name | Approval card titles |
| `routes/-settings/passthrough-section.tsx:35-99` `PASSTHROUGH_META` | supported slug | Label and helper copy |
| `routes/-integrations/detail/detail-header.tsx:28-33` `CONNECT_PATHS` | catalog id | Connect URLs with hand-written `?features=`; Railway absent, handled by `provider.id === "railway"` |
| `routes/-integrations/detail/provider-policy.tsx:8-18` `PROVIDER_TO_SLUG` | catalog id to slug | Nine rows; `notion`, `railway`, `vercel` **missing**, so their policy control never renders |
| `routes/-integrations/featured-hero.tsx:8` | brand | Default featured brands |
| `components/onboarding/onboarding-flow.tsx:448-503` `POPULAR_INTEGRATIONS` | catalog id | id, name, description, brand, `bundledWithGoogle`, status |
| `routes/-settings/user-section.tsx:31-63` | channel | Per-channel label and glyph; iMessage has an inline glyph, no brand asset |
| `routes/-briefings/source-meta-utils.ts:25-40` `PROVIDER_BRAND`, `PROVIDER_COLOR` | slug to brand | Nine rows; same three **missing** |
| `routes/-briefings/source-meta.tsx:20-31` `SOURCE_BRAND` | gather source | `email` to `gmail`, `calendar` to `google_calendar` |
| `routes/-briefings/briefing-link.tsx:23-35` | URL host | Host to brand |
| `routes/-workflows-detail/plan-tab.tsx:39-52` `integrationLabel` | slug | `humanizeSlug`, so `github` renders as "Github" |

## 4. Display name: the four homes today

| Home | `calendar` renders as | `github` renders as | `imessage` renders as |
| --- | --- | --- | --- |
| `contracts/tools.ts` `INTEGRATION_DISPLAY_NAMES` | Calendar | GitHub | iMessage |
| `apps/web` `INTEGRATION_PROVIDERS.name` | Google Calendar | GitHub | no entry |
| `humanizeSlug` in `registry.ts:369` and `plan-tab.tsx:50` | Calendar | Github | Imessage |
| `mention-options.ts`, `passthrough-section.tsx`, `onboarding-flow.tsx` labels | hand-typed per file | hand-typed per file | hand-typed per file |

## 5. Behavior that switches on the integration

- `registry.ts:324,559,589` — `system` is exempt from allow-list filtering and the policy waiver.
- `registry.ts:356-425` — `isLoadableIntegrationSlug` decides whether the availability snapshot applies.
- `dispatch/index.ts:1076-1109` — `system` is exempt from suggestions and nudges; only `system` resolves to `autonomy`.
- `surface-adapter.ts:33,94` — `system` is excluded from the grouped model surface.
- `readiness.ts:103-180` — Gmail-only event-trigger readiness.
- `recovery-navigation.ts:4-25` — the six Google slugs get a re-consent navigation.
- `railway-fanout.ts` — Railway-only multi-credential fan-out.
- `passthrough/rest-adapter.ts` vs `railway-adapter.ts` — transport chosen per slug.
- `use-integration-status.ts:81,108,362-397` — `switch (backend)` and `switch (credentialShape)`.
- `detail-header.tsx:57` — Railway renders a token form, not an OAuth redirect.
- `tool-call-presentation.ts:118,126` — `system` and `web` branches.
- `mention-connection.ts:44-52` — `PROVIDER_BACKEND.has(...)` decides connectable vs unavailable; this hides Slack and Linear.

## 6. Key-space mismatches

1. **slug vs catalog id.** Six Google slugs de-prefix. `imessage`, `mcp`, `system` have no catalog entry. `web` and `collaborators` are brands with no slug.
2. **Three partial slug tables in the web app drift independently.** `SLUG_TO_BRAND`, `PROVIDER_BRAND`, and `PROVIDER_TO_SLUG` each have nine rows and each lack `notion`, `railway`, `vercel`. The alias table has six rows. None is typed `Record<IntegrationSlug, ...>`, so a missing row compiles.
3. **`IntegrationBrand` is its own union.** It includes non-integrations and excludes three slugs.
4. **slug vs credential provider.** Six slugs collapse to `google`. `ACCESS_SPECS` is the only map, and it lives in `assistant`, not `contracts`. The DB column is untyped text.
5. **Google has three internal key spaces.** `GoogleFeature` has `briefing`, `triage`, `reply_draft` and no `gmail`. The web `?features=` strings are hand-written against it.
6. **`web` leaks into the tool namespace** in `tool-call-presentation.ts` and `mention-options.ts`.
7. **`chatConnectNudge.integration` is `z.string()`**, not `z.enum(INTEGRATION_SLUGS)`.
8. **Adjacent source enums reuse the words but are different concepts.** `DOCUMENT_SOURCES` has `gcal` and `gmail_attachment`. `OBSERVATION_SOURCES` has `google_calendar` and `clickup`. `GATHER_SOURCE_SLUGS` has `email`. These describe provenance of data, not the integration entity. They should map **to** a slug where one exists, not fold into the registry.

## 7. What one registry entry would hold

Facts every integration has, and where they live today:

| Field | Today |
| --- | --- |
| `slug` | `contracts/tools.ts` |
| `displayName` | four homes, section 4 |
| `brand` | `integration-icons.tsx` plus three slug-to-brand maps |
| `credentialShape` | `contracts/credentials.ts` |
| `provider` (credential row value) | `assistant/connections/availability.ts` |
| `backend` (route family) | `apps/web/integrations.ts` |
| `connectPath` and features | `detail-header.tsx`, `google-routes.ts` |
| `requiredScopes` | `apps/web/integrations.ts`, `google/oauth.ts` |
| `actions` | `contracts/tools.ts` |
| `passthrough` coverage and transport | `contracts/passthrough.ts` |
| `policyDefault` | `contracts/tools.ts` |
| `status`, `category`, marketing copy | `apps/web/integrations.ts`, `onboarding-flow.tsx` |
| `summaryBlurb` (model-facing) | `connected-summary.ts`, eval duplicate |
| `faviconDomain` | `evidence.ts` |

Facts that stay outside the registry because they are per tool, per provider client, or per
Google scope, not per integration: `TOOL_LABELS`, `TOOL_CATEGORIES`, `tool-schemas.ts`,
`REST_GATE_CONFIG`, `providerRegistry` client factories, `AUTHORITY_SCOPES`, the route
handlers themselves, and the adjacent source enums in section 6 item 8.

## 8. Constraints for the design

- `@alfred/contracts` is browser-safe. Icons, tile components, and colors are web assets. The
  registry can own the brand **key**; the web owns the asset keyed by it.
- `packages/integrations` must not import `app-errors` (typed-failures plan, section 9 item 4).
  The registry must not create a `contracts` to `integrations` dependency in the wrong direction.
- `mcp` is a slug by design and not loadable (`tools.ts:24-33`). The registry needs a field for
  that, not an exclusion.
- Every per-slug table in the registry must be `satisfies Record<IntegrationSlug, ...>` or
  derived from the entry list, so the three missing-row bugs in section 6 item 2 cannot recur.
- The web `IntegrationProvider` type should become a projection of the registry entry plus
  web-only fields, not a second declaration.

## 9. Open questions before design

1. Does the web catalog id survive, or does the web key on the slug and derive `google_*`
   for asset filenames only?
2. Does `provider` (credential row value) join the registry as a field, or does it stay a
   `packages/integrations` concern with a typed column?
3. Do `slack` and `linear` stay as slugs with empty action lists, or move to a `planned`
   status on the registry entry?
