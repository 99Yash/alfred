# ADR-0094 — Alfred's GitHub MCP surface stays read-only by PINNING the read-only resource, not by filtering tools; a built-in carries a scope baseline in code

**Decision.** Alfred's built-in GitHub MCP connection targets `https://api.githubcopilot.com/mcp/readonly`, GitHub's read-only protected resource, and never the read-write `/mcp` root. Read-only is a property of the RESOURCE Alfred connects to. It is not a per-tool allow-list, not a risk tier, and not a prompt instruction.

Two sub-decisions follow from it:

1. **A built-in provider pins its OAuth scope ask in code.** `BUILT_IN_REGISTRY[provider].scopes` is a baseline requested on every authorize. `mcpConsentAsk` unions it with the connection's granted scopes and with any scope the server demanded through an insufficient-scope response. The baseline is derived from the endpoint at authorize time, never stored, so widening it needs no migration and no backfill.
2. **The endpoint href stays the canonical resource, and therefore the durable row identity.** Moving the path is a data migration on `mcp_servers`, not a new row. The provider key is DERIVED from the endpoint (`builtInProviderForEndpoint`), following ADR-0093's rule that a provider is a fact about the record and not a stored column.

**Amends ADR-0018** (the MCP broker's endpoint pin). **Does not change ADR-0088** (the `mcp.call` approval floor still applies to every tool a catalog contains). **Does not change ADR-0052**, which is about the GitHub App's REST permissions and the notifications poller, and which states no rule about the MCP surface.

---

## Why this is its own ADR

The branch that moved the endpoint cited ADR-0052 as the authority for "Alfred's GitHub surface stays read-only". That citation does not hold. ADR-0052 records that the GitHub App was registered with read-only `metadata` / `pull_requests` / `issues` / `contents` permissions, and it says the opposite thing about scope: that OAuth's `repo` scope "already grants read across all the user's repos", which is why polling ships with no migration. It draws no boundary around what MCP may expose. So the read-only pin was a new architecture rule resting on a misread of an old one.

The rule needs to be written down because the mechanism is not visible from any single file. Nothing in the code reads a per-tool `annotations.readOnlyHint`. The reason the boss cannot reach `merge_pull_request` is one character-level fact about one constant. A `pnpm check` gate now guards that constant — `read-write-github-mcp-endpoint` in `scripts/consolidation-rules.mjs` fails the build on a `/mcp` href that does not continue into `/readonly` — but a gate states no reason. This ADR is the reason.

## The forced trade

GitHub's remote MCP server decides what its `tools/list` contains from the token it is given, and it HIDES a tool whose scope the token lacks rather than failing the call. A `gho_` token with an empty scope produced a catalog of 8 tools that contained no pull request tool and no issue tool at all. Nothing in the MCP protocol reports that shortfall, so the shortfall cannot be discovered at run time.

`repo` is GitHub's only grain for private repository content. There is no read-only private-repo scope. So Alfred must ask for a scope whose consent screen states write access in order to see the pull request READS it wants. Measured with one `repo`-scoped token:

| Resource        | Tools | Write tools |
| --------------- | ----: | ----------: |
| `/mcp`          |    47 |          16 |
| `/mcp/readonly` |    28 |           0 |

The grant is the same in both rows. The resource is what differs. Pinning the read-only resource is therefore the only lever that separates "can read private pull requests" from "holds a write catalog", and it is a lever GitHub operates, not Alfred.

## Alternatives

- **(a) Keep `/mcp` and filter the catalog to read tools at publish time.** Rejected. The filter is a list Alfred maintains against a catalog GitHub versions; a tool GitHub adds is admitted by default, which is the wrong direction for a write. It also puts the whole write catalog inside the token's reach, so any bug below the filter is a write.
- **(b) Keep `/mcp` and rely on the ADR-0088 approval floor.** Rejected as the ONLY control. The floor is real and stays, but it asks the user to be the read/write classifier on every call, and it is a floor on `mcp.call`, not a bound on what the boss can see and plan with.
- **(c) Ask for a narrower scope than `repo`.** Rejected because it does not exist. The measured consequence of trying is the 8-tool catalog.
- **(d) Store the scope baseline on the `mcp_servers` row.** Rejected. It would need a migration and a backfill for every widening, and it would give the two existing scope columns a third meaning.
- **(e) Store the built-in provider in a `built_in_provider` column on `mcp_servers`, instead of deriving it from the endpoint.** Rejected, and the reason is the same failure this ADR's own migration exists to force. *(Added 2026-09-03, closing the follow-up PR #958 left open.)*

  A stored provider makes a retarget look healthy when it is broken. The endpoint href is the canonical resource and therefore the durable row identity, so moving it is a data migration (`0112`). If someone edits `GITHUB_MCP_ENDPOINT_HREF` and forgets the migration, the derived reading answers `undefined` and the `/integrations` card renders the row as user-added — visibly wrong, at the row that is wrong. A stored column would keep answering `github` for a row whose endpoint no longer matches the registry, while `ensureBuiltInConnection` mints a SECOND row that also claims `github`. Two healthy-looking GitHub cards is a worse report than one wrong one.

  It also buys nothing. The href is updated in place, so no historical href is stored anywhere and no audit row loses its provider. Finding the connection in SQL by `canonical_resource` is not harder than by a provider column at single-user scale.

  The amendment above adds the third reason. `readOnlyCatalog` and `pinLegacyProtocol` are endpoint-derived facts too, and `builtInClientPolicy` reads all of them through one lookup. If the provider were stored and the other two derived, a stale column could pair GitHub's read-only pin with a non-GitHub endpoint. Deriving every one of them from one key keeps them consistent by construction, which is ADR-0093's rule stated as a mechanism rather than a preference.

## Residual risk

Read-only is enforced by the value of one constant, and the guard on that constant is a text match. It covers what it can reach and no more:

- It reads `*.ts` and `*.tsx` only, so `.env.example` and the `0112` migration hold the same href with nothing watching them.
- It skips comment-only lines, because a doc example of a banned idiom is not drift. A stale docstring can therefore name `/mcp` and pass.
- It proves the ADDRESS, never the CATALOG. If GitHub adds a write tool at `/mcp/readonly`, Alfred publishes it and every check stays green.

The last item was the real gap. The amendment below closes it. The ADR-0088 approval floor on `mcp.call` still stands behind both controls.

---

## Amendment, 2026-09-03 — a read-only built-in also refuses a catalog on the per-tool annotation

**The residual risk above is closed, and its stated reason for staying open was wrong.**

Two claims in that section do not survive measurement:

1. *"Nothing in this repo captures MCP tool annotations today."* Annotations were already captured. `mcp_catalog_revisions.descriptors` stores the raw, validated `Tool[]` exactly as admitted, the MCP SDK's `ToolSchema` carries `annotations`, and `sha256Canonical` folds the field into `revisionHash`. What was missing was a READER and a REFUSAL, not storage.
2. *"A guard built on GitHub's `readOnlyHint` fidelity would fail closed on the live catalog."* It would not. Measured against both resources on 2026-09-03 with one `repo`-scoped token:

| Resource        | Tools | `readOnlyHint: true` | `readOnlyHint: false` | Hint absent |
| --------------- | ----: | -------------------: | --------------------: | ----------: |
| `/mcp`          |    47 |                   28 |                    19 |           0 |
| `/mcp/readonly` |    28 |                   28 |                     0 |           0 |

GitHub omits the hint from nothing. The 28 names it serves at `/mcp/readonly` are byte-identical to the `readOnlyHint: true` subset of the 47 it serves at `/mcp`, so GitHub appears to derive the read-only resource from the same annotation Alfred can now read. This table also corrects a count: the write catalog is **19** tools, not the 16 the original decision reported.

**The rule.** `BuiltInDefinition.readOnlyCatalog` marks a provider whose endpoint is a read-only protected resource. `McpRawClient` refuses the whole catalog refresh when any descriptor fails to assert `annotations.readOnlyHint === true` (`McpClientError` code `write_tool`). The policy is INJECTED, not looked up: the raw client knows nothing about the built-in registry, so `liveClientFactory` reads `builtInReadOnlyCatalog(endpointUrl)` and passes the answer. `builtInReadOnlyCatalog` stays off the `connections/mcp` barrel, like `builtInAuthorizationScopes`.

**Absence fails like `false`.** The specification makes every annotation optional, so a missing hint states nothing. Reading "said nothing" as "is a read" is the one reading that admits a write.

**Refuse the refresh, do not filter the catalog.** A write tool at a read-only resource is the server breaking its own contract. Publishing 27 of 28 tools would hide that behind a connection that looks healthy. The connection instead goes to `failed` with the tool named in `lastError`. That is affordable precisely because the MCP catalog is not yet the practical GitHub door — the curated `github.*` reads are — so a loud outage costs little today and states the problem in the one place an operator reads.

**This does not reverse alternative (a).** Rejected alternative (a) is a hand-maintained ALLOW-LIST of read tools over the read-write root, which admits a tool GitHub adds by default. This is the inverse: default-deny on a field the server itself supplies, layered on top of the resource pin, over a resource that already holds no write tool.

**On the specification's warning about hints.** The MCP specification says a client should never make a tool-use decision from an annotation received from an untrusted server. That warning holds, and it does not bind here, because Alfred only ever REFUSES on this field. A server that lies with `readOnlyHint: true` on a write tool defeats this condition and does not defeat the resource pin, which serves no such tool. Nothing a server can say WIDENS what Alfred admits. The two controls therefore fail in different directions, which is what makes them worth having together.

### What still stays open

- **The gate reads `*.ts` and `*.tsx` only.** `.env.example` and `0112_retarget_github_mcp_readonly.sql` still hold the same href with nothing watching them, and the gate still skips comment-only lines.
- **A user-added server is unaffected.** `readOnlyCatalog` is false for every endpoint no built-in claims, so a user-added server keeps whatever catalog it discovered. The ADR-0088 approval floor is the only control there, by design.
- **The refusal is total.** If GitHub drops the hint from one read tool, Alfred's whole GitHub MCP connection goes dark until someone changes code. That is the chosen direction, not an oversight.
