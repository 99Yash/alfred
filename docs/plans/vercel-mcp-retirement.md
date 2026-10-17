---
status: done
evidence: "#1259 (transport), #1350 (steps 2 and 3), #1353, #1355, #1356. Gate 1 measured in production 2026-10-17 (#1193)."
---

# Retire the Vercel MCP built-in; serve the pull from the curated Vercel grant

Status: done. Steps 1 to 3 are in code (#1259, #1350). Gate 1 was met in production on
2026-10-17 (#1193): the `/v10/projects` and `/v7/deployments` bodies passed the client's
schemas from the production container. A probe branch on `99Yash/olivia` went READY,
ERROR, then READY, and after each step the pull read the same deployment that the
target row held. #1353, #1355, and #1356 fixed what the live pull then showed. The "not yet measured" lines below are the record from before that.

Decides: [ADR-0093](../decisions/ADR-0093-integration-registry-one-entry-per-integration.md)
rule 1, [ADR-0062](../decisions/ADR-0062-integration-object-state-memory-a-deterministic.md)
#1008 and its 2026-09-23 #1193 amendment

## Outcome

The Vercel verified pull reads over the curated Vercel OAuth grant that already
ships in Alfred, and the Vercel MCP built-in leaves the registry. The
`BuiltInDefinition.clientRegistrationRedirects` seam stays, because it is the
honest general answer for an authorization server that cannot be reached from a
hosted deployment.

## Why the MCP path cannot be made to work

Vercel's authorization server publishes a `registration_endpoint`, so Alfred
registers its own client under RFC 7591, and the registration is still refused.
Measured 2026-09-27 by POSTing Alfred's real production callback,
`https://<host>/api/integrations/mcp/callback`, to every built-in's registration
endpoint:

| Built-in | Registration of the production callback |
| --- | --- |
| Sentry, Linear, Notion, Polylane, Railway | `201`, client issued |
| Vercel | `400 invalid_redirect_uri` |

Vercel is the only one of the six that refuses, and it accepts only
`http://localhost[:port]/…`. Alfred's callback is derived from
`BETTER_AUTH_URL` (`mcpOAuthClientConfiguration`, `connections/mcp/oauth.ts`),
so a hosted deployment can only ever present an `https://` URI.

This is a policy wall, and three of the four ways around it are closed on
measured or stated grounds. The pin is closed for a hosted callback by a rule
Alfred consults first, and whether Vercel would then honour one is UNVERIFIED:
a Vercel-issued `client_id` asked to authorize an `https:` callback would settle
it. The loopback redirect is closed by measurement and by Vercel's stated terms,
and the dashboard by a measured `404`. The fourth, Vercel Connect, is counted
neither way here: this plan does not say where its requirements come from, and
nothing in it measured them:

- **Pin a client.** Nothing Alfred can see blocks one, and not for want of a
  client identity. Vercel publishes
  `token_endpoint_auth_methods_supported: ["none"]`, so its registered clients
  are public — what Alfred's own RFC 7591 registration asks for
  (`token_endpoint_auth_method: "none"`, `connections/mcp/oauth.ts`) and what
  its `static` arm resolves, since it omits an absent `clientSecret`. The pin is
  not consulted anyway: `resolveBuiltInClient` asks
  `clientRegistrationRedirects` first, so a hosted callback never reaches it.
  Whether Vercel would then honour a hosted callback for a Vercel-issued
  `client_id` is UNVERIFIED, because the 2026-09-27 measurement posted the
  registration endpoint and nothing else. A Vercel-issued `client_id` asked to
  authorize an `https:` callback would settle it.
- **Use a loopback redirect and collect the code out of band.** Technically the
  registration succeeds, which is why it was considered, and it is declined on
  two grounds. One is Vercel's stated intent rather than a protocol
  constraint: its documentation says "Vercel MCP only supports AI clients that
  have been reviewed and approved by Vercel", Alfred is not on the list of
  fourteen, and the two hosted clients on it — ChatGPT and Claude —
  authorize with Vercel-issued `client_id`s. Reading a list is an inference
  from a document, not a measurement. Working around the check would be using
  the service outside its stated terms on an endpoint that can be closed at
  any time. The other ground is measured: the endpoint is IP-keyed and
  fragile for a hosted deployment — four registrations from one address with
  different `client_name` and port all returned the SAME `client_id`, each
  overwriting `redirect_uris`, so two concurrent connects break each other's
  in-flight authorization — and rate limited to `x-ratelimit-limit: 20` per
  hour, which on a shared deployment IP is twenty connects an hour for every
  user combined.
- **Register a client in the dashboard.** There is no such screen;
  `<team>/~/settings/mcp` answers `404`, and the `Agent` navigation item is a
  different product.
- **Vercel Connect**, the sanctioned hosted path, supplies short-lived tokens to
  an MCP client. It requires the application to be deployed ON Vercel, linked
  with `vercel link`, holding a `VERCEL_OIDC_TOKEN`, and using dashboard-created
  connectors keyed by UID. Alfred runs on Railway.

The curated grant avoids all four. It is Vercel's supported OAuth-app flow with
a configurable redirect URL, and it is already built: `oauth.ts`, `client.ts`,
`credential.ts` in `packages/integrations/src/vercel/`, routes in
`packages/http/src/connections/vercel-routes.ts`, and `VERCEL_CLIENT_ID`,
`VERCEL_CLIENT_SECRET`, `VERCEL_REDIRECT_URI`, `VERCEL_APP_SLUG` in
`packages/env/src/server.ts`. Tokens are non-expiring and minted at
`https://api.vercel.com/v2/oauth/access_token`; a team install returns the
`team_id` that every later call echoes as `?teamId=`.

## What is already done

Before this plan, #1259 put
`BuiltInDefinition.clientRegistrationRedirects: "loopback-only"` on the Vercel
entry, with a fourth `BuiltInClientResolution` arm and a sentence from
`builtInClientUnavailableMessage`, and marked `VERCEL_MCP_STORED_ISSUER`
unverified. Step 2 has since deleted the entry and the constant. The field, the
arm and the sentence stay, with no entry using them; the sentence no longer
names Vercel.

## Delivery sequence

### 1. Repoint the verified pull at the curated grant

Status: done in code, not yet measured (#1259 swapped the transport; #1193 follow-up
fixed the preview claim). The live gate below is still open.

What shipped differs from the bullets in three places, and the code is the
record:

- The reads are `GET /v10/projects` and `GET /v7/deployments`, which are the
  versions Vercel's REST reference documents on 2026-10-17, not `/v9` and `/v6`.
- The pull calls no `GET /v2/teams`. The curated install already returns the
  `team_id`, and the client pins it as `?teamId=` on every call, so there is no
  team to choose. The probe below reads `/v2/teams` to measure it, and nothing
  else does.
- The REST swap first folded Vercel's `target: null` (a preview deployment)
  into "no claim", so no preview target could ever close. The client now
  reports `environment`: `target` as sent, `preview` for `null`, and no claim
  for an absent `target` or a deployment that names a `customEnvironment`.
  That is the rule the MCP-era provider had.

Every response is parsed by a Zod schema in `packages/integrations/src/vercel/client.ts`.
A non-2xx, a timeout (`INTEGRATION_FETCH_TIMEOUT_MS`), or a body the schema
refuses throws, and the provider turns every throw into `null`, so the driver
reads it as unverified. To measure, run the untracked probe
`references/scratch/vercel-rest-probe.ts` with a real token: it issues only the
three GETs and reports whether each body passes the client's schemas.

- Read the bearer credential the existing Vercel credential layer already
  stores, rather than opening an MCP connection.
- Replace `list_teams`, `list_projects` and `list_deployments` with
  `GET /v2/teams`, `GET /v9/projects` and `GET /v6/deployments`, honouring the
  `team_id` the install returned.
- Keep the `owner/repo#branch#environment` target row, the recency rule, and the
  `VERIFIED_PULLS` registry entry unchanged. This is a transport swap inside one
  provider file, not a registry change.
- Measure every response shape against the live wire before trusting it. The
  existing MCP shapes are explicitly unmeasured (`vercel.ts` module docstring),
  so this is the first time these three reads are actually verified.

Gate: a live pull resolves a pushed deployment to its target row, and an
unmeasured or drifted shape reads as unverified rather than as fact.

### 2. Drop the Vercel MCP built-in

Status: done in code (#1193 follow-up). The registry and catalog entries, the
three constants, and the `vercelSiblings` exception are gone. The registry's
`oauthPolicy` field and `McpEndpointOAuthPolicy` went with them, because Vercel
was their only user: an issuer pin and an origin list that no entry sets enforce
nothing. The four web tables stay, because the curated grant still uses the
`vercel` slug. The stored `https://mcp.vercel.com/` rows are a plain data
delete for the owner to run, recorded in the PR; no migration ships.

- Remove the `vercel` entry from `BUILT_IN_REGISTRY` and from
  `BUILT_IN_MCP_CATALOG`, plus the four web tables the entry needs
  (`BRAND_SVGS`, `BRAND_ICONS`, `INTEGRATION_TILES`, `INTEGRATION_PAGE_COPY`)
  if the `vercel` slug is not still a provider for the curated grant. The
  compiler names the registry half; the other tables are the three further edits
  ADR-0093 records that it cannot.
- Delete `VERCEL_MCP_ENDPOINT_HREF`, `VERCEL_MCP_STORED_ISSUER`,
  `VERCEL_MCP_OAUTH_ENDPOINT_ORIGINS`, the endpoint authorizer's `vercelSiblings`
  origin exception, and the `mcp_connections` / `mcp_servers` rows for the
  `https://mcp.vercel.com/` resource. No user can hold a working one: every
  authorize has been refused since the entry shipped.
- Keep `clientRegistrationRedirects`. It is the general seam, and the next
  allowlisted-only server will need it.

### 3. Re-point the integrations card

Status: done in code (#1193 follow-up). The curated `INTEGRATIONS.vercel` entry
already rendered its own card. With the MCP tile gone it is the only Vercel
tile, and its page copy now says that the deployment reads use this grant.

- The Vercel tile renders from the curated grant's connection, on the same
  `INTEGRATIONS` slug the rest of the curated providers use. The card is
  registry-driven, so this is a wiring change and not a new component.

## Invariants

- Do not keep a Vercel MCP connection row alive to carry a
  `VERCEL_MCP_STORED_ISSUER` that was never measured.
- Do not let a failed REST read report as a verified fact. The
  unverified-means-unverified rule in `VERIFIED_PULLS` is what keeps a shape
  drift from becoming a wrong succession, and the REST swap is exactly where that
  rule is load-bearing.
- Do not widen `oauthEndpointOrigins` to make an endpoint reachable. The
  `vercelSiblings` exception is deleted with the entry, not generalised.
- Do not re-add Vercel to the MCP registry without a measurement showing the
  server accepts a non-loopback redirect URI.

## Residual risk

The REST response shapes for `/v10/projects` and `/v7/deployments` (and
`/v2/teams`, which only the probe reads) are written from Vercel's API
documentation and have not been read off the live
wire. That is why gate 1 requires measuring them, and why an unrecognised shape
must read as unverified rather than defaulting to a value. This is the same
exposure the MCP path carried, and it is the reason the pull has never closed
the loop.
