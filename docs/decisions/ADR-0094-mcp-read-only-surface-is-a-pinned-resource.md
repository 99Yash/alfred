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

## Residual risk

Read-only is enforced by the value of one constant, and the guard on that constant is a text match. It covers what it can reach and no more:

- It reads `*.ts` and `*.tsx` only, so `.env.example` and the `0112` migration hold the same href with nothing watching them.
- It skips comment-only lines, because a doc example of a banned idiom is not drift. A stale docstring can therefore name `/mcp` and pass.
- It proves the ADDRESS, never the CATALOG. If GitHub adds a write tool at `/mcp/readonly`, Alfred publishes it and every check stays green.

The last item is the real gap, and it stays open. Nothing in this repo captures MCP tool annotations today, and a guard built on GitHub's `readOnlyHint` fidelity would fail closed on the live catalog if GitHub omitted the hint from a read tool. Capturing annotations and gating the publish on them is the follow-up that closes it. Until then the ADR-0088 approval floor on `mcp.call` is the control that stands behind the pin.
