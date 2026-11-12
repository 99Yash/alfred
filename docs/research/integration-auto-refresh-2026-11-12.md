# Integration auto-refresh: what can heal without the owner

Date: 2026-11-12. Question from the owner: can Alfred keep its integrations connected without a manual reconnect, as Pipedream and Nango do?

Short answer: yes for every failure that is not a dead grant. A dead grant (the provider says the refresh token or the installation is gone) always needs the owner. Everything else (access-token expiry, push-channel expiry, 5xx, 429, network faults, a grant that expires when it is not used) can heal with no human. Alfred already does most of this. This note lists the gaps and the fixes.

Sources are primary only: provider docs, RFCs, the MCP specification, and the source code of Nango and Executor at pinned commits. Pipedream is closed source, so only its public docs were read.

## 1. What needs the owner, and what does not

| Provider | Needs the owner (dead grant) | Heals with no human |
| --- | --- | --- |
| Google | `invalid_grant` for any cause: revocation, password change with Gmail scopes, 6 months unused, more than 100 live refresh tokens, time-based access ended, account disabled ([Google OAuth: expiration](https://developers.google.com/identity/protocols/oauth2#expiration)). `invalid_rapt` applies only to the Cloud Platform scope ([session control](https://developers.google.com/identity/protocols/oauth2#gcp-session-control)). | Access-token expiry, 5xx, 429, network. Gmail `watch` renewal: "at least once every 7 days", daily recommended ([Gmail push](https://developers.google.com/workspace/gmail/api/guides/push)). |
| GitHub App | Installation `deleted` or `suspend`; user token `bad_refresh_token` ([installation webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation), [bad refresh token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#bad-refresh-token)). | Installation tokens: 1 hour, minted from the App JWT, never need the user ([installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)). `unsuspend` restores. |
| Vercel | `integration-configuration.removed`; 403 `integration_configuration_disabled` ([Vercel API integrations](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#disabled-integration-configurations)). | The token is long-lived, with no `expires_in` and no refresh token, so nothing to refresh. |
| MCP OAuth | `invalid_grant`; no refresh token issued; `insufficient_scope` step-up ([MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)). | Access-token expiry with a refresh token; 5xx, 429, network. |

Two rules apply to every provider:

- RFC 6749 §5.2 lists the token-endpoint errors. Only `invalid_grant` says that the grant is dead. `invalid_request` is a malformed request, and `invalid_scope` on a refresh means "retry with no `scope`" ([RFC 6749 §5.2](https://www.rfc-editor.org/rfc/rfc6749#section-5.2), [§6](https://www.rfc-editor.org/rfc/rfc6749#section-6)). `server_error` and `temporarily_unavailable` are defined only for the authorization redirect. At the token endpoint, a transient fault is an HTTP 5xx, a 429, or a network fault.
- A rotated refresh token that is used twice looks like theft. The server can revoke the whole grant ([RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.14.2)). Thus one refresh per connection at a time, and save the new token before use. MCP public clients get rotation by rule ([MCP token theft](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-theft)).

## 2. How the platforms do it

Pinned commits: Nango `b7b8065ef6679e9b172bf0f2e5ba427c532ad783`, Executor (the executor.sh open-source repo, `UsefulSoftwareCo/executor`) `4bb588262fde0584ddc947d06d8b5c4677af32c2`.

- **Nango refreshes in the background.** A cron every 10 minutes selects connections not touched for 1 day and refreshes the ones within 15 minutes of expiry ([refreshConnections.ts](https://github.com/NangoHQ/nango/blob/b7b8065ef6679e9b172bf0f2e5ba427c532ad783/packages/server/lib/crons/refreshConnections.ts#L28-L67), [connection.service.ts](https://github.com/NangoHQ/nango/blob/b7b8065ef6679e9b172bf0f2e5ba427c532ad783/packages/shared/lib/services/connection.service.ts#L1099-L1131)). The docs say "refreshes each access token at least once every 24 hours". The code does not force it: a token with a long lifetime is not refreshed ([refresh.ts](https://github.com/NangoHQ/nango/blob/b7b8065ef6679e9b172bf0f2e5ba427c532ad783/packages/shared/lib/services/connections/credentials/refresh.ts#L669-L682)).
- **Nango counts failures by day.** At most one failure counts each day, and it gives up after 4 failing days. Any success clears the count ([connection.service.ts](https://github.com/NangoHQ/nango/blob/b7b8065ef6679e9b172bf0f2e5ba427c532ad783/packages/shared/lib/services/connection.service.ts#L965-L990), [refresh.ts](https://github.com/NangoHQ/nango/blob/b7b8065ef6679e9b172bf0f2e5ba427c532ad783/packages/shared/lib/services/connections/credentials/refresh.ts#L554-L563)). Nango does not tell `invalid_grant` from a 5xx.
- **Executor classifies.** Only `invalid_grant` and the services' own names for it end the grant. Every other failure keeps it ([oauth-protocol.ts](https://github.com/UsefulSoftwareCo/executor/blob/4bb588262fde0584ddc947d06d8b5c4677af32c2/packages/sdk/src/implementation/oauth-protocol.ts#L395-L426), [oauth.ts](https://github.com/UsefulSoftwareCo/executor/blob/4bb588262fde0584ddc947d06d8b5c4677af32c2/packages/sdk/src/implementation/oauth.ts#L400-L458)). Executor has no background refresh.
- **Pipedream** shows `healthy`, `dead`, `last_refreshed_at`, and `next_refresh_at`, and "will periodically retry token refresh and test requests for unhealthy accounts" ([Account schema](https://pipedream.com/docs/connect/api-reference/retrieve-account)).

The full captures are in `references/scratch/integration-refresh-provider-facts.md` and `references/scratch/integration-refresh-platform-patterns.md` (not tracked).

## 3. Alfred: what is already correct

- Google refreshes on demand under a row lock with a re-read, so two workers never both call Google. Only `invalid_grant` writes `needs_reauth`. A 5xx, a 429, or a timeout keeps the row `active` (`packages/integrations/src/google/credentials.ts`).
- Gmail polling every 5 minutes uses the token, so a Gmail grant never reaches 6 months unused.
- MCP OAuth refreshes are single-flight per process and serialized across processes by an advisory lock with a re-read. A transient refresh failure keeps the refresh token (`packages/assistant/src/connections/mcp/oauth.ts`).
- The MCP recovery pass re-probes `connecting` and `failed` connections every 5 minutes.
- GitHub uses installation tokens only, which never need the owner.

## 4. Gaps fixed in this change

| Gap | Before | After |
| --- | --- | --- |
| A Gmail account whose first watch install failed | The renew sweep renewed only existing watches. The account showed "Reconnect Gmail", and with no cursor the poll sweep skipped it. | `gmail.watch_renew` also installs a missing watch on each active account with a Gmail scope. The install seeds the cursor. |
| MCP refresh "at intervals" (owner decision 2026-10-22, `docs/theory/product-direction.md`, "Custody") | Refresh happened only before a call. A grant that expires when not used died on a quiet connection. | An hourly keep-alive refreshes each `ready` or `stale` OAuth grant with no refresh in 24 hours. A dead grant moves the connection to `auth_required` at once, so the owner sees it before the next call. |
| MCP dead-grant list | `invalid_request`, `invalid_scope`, `access_denied`, and `unsupported_grant_type` deleted the tokens. The comment said "Executor's refresh rules, ported", but Executor keeps the grant for these. | Only `invalid_grant`, its vendor aliases (Executor's list), and a refused client (`invalid_client`, `unauthorized_client`) end the grant. Alfred registers one client per connection, so a refused client ends its grant. |
| MCP start where the server rejects a renewed token twice | The row stayed `connecting` with no `lastError`. Recovery needs a `lastError`, so it skipped the row. | The start writes `lastError` and keeps the status, so recovery retries it. |

## 5. Open items for the owner

These change a settled decision or are larger than a fix. They are not in this change.

1. **Do not alert on an MCP `failed` row that recovery can still heal.** ADR-0100 item 4 alerts at once (banner, email, briefing), and the card button reads "Reconnect". Recovery heals most of these rows within 10 minutes. Proposal: alert only after the row stays `failed` for 30 minutes, or when it holds no usable token. This changes ADR-0100.
2. **GitHub installation state.** No code writes a GitHub row to `needs_reauth`, so an uninstalled or suspended App still shows Connected. A reinstall from GitHub settings gets a new installation id, and Alfred drops its webhooks as `no_owner` (#1033). Proposal: act on the `installation` webhook (`deleted`, `suspend` → `needs_reauth`; `unsuspend` → `active`; `created` → rebind a personal install to the existing row).
3. **Vercel revocation.** A revoked Vercel token stays `active` (`packages/integrations/src/shared/credentials.ts` says so). Proposal: write `needs_reauth` on a 401 or on `integration_configuration_disabled`.
4. **Gmail broken-delivery alert before a repair.** The delivery-alert sweep emails "Reconnect Gmail" for a lapsed watch. With fix 1, the renew sweep repairs it within 6 hours. Proposal: the alert sweep tries one watch install first.
5. **A failure count for MCP keep-alive.** The keep-alive retries a transient failure every hour with no limit. Nango gives up after 4 failing days. With one owner and few connections, the cost is only log lines, so this change has no count.
