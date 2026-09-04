# ADR-0095 — Alfred refuses `x-mcp-header` in the era that ACTS on it, and pins the legacy protocol era for a built-in whose catalog declares it

**Decision.** `x-mcp-header` in a tool's input schema is refused when the NEGOTIATED protocol era mirrors it into a `Mcp-Param-*` request header, and admitted when the negotiated era ignores it. A built-in provider may pin the legacy era (`2025-11-25`) for exactly this reason. GitHub's built-in pins it.

Three sub-decisions follow:

1. **The condition is the negotiated era, never the pin.** `McpRawClient` reads the negotiated profile's own `mirrorsParamHeaders` field at admission, and reads it fail-closed (`!== false`), so an absent negotiation refuses rather than admits. A pin that fails, or that a later edit removes, therefore closes the gate again by itself, and the proof is the expression rather than the order in which `#connect` assigns its fields.
2. **A pinned era is a choice between two supported profiles, not a fallback.** `MCP_PROTOCOL_PROFILES` in `protocol.ts` implements both eras in full. The pin is one field on the built-in definition (`pinLegacyProtocol`), spread into the client by `liveClientFactory` together with the ADR-0094 read-only flag.
3. **"Which era mirrors" is a field on the profile, not a comparison at the call site.** `MCP_PROTOCOL_PROFILES[era].mirrorsParamHeaders` is the one home for the fact, so a third era must declare it and the admission rule never restates an era literal. `McpNegotiatedServer` already spreads the whole profile, so the client reads the field it was given.

**Amends the first-profile rule** in `docs/plans/mcp-2026-07-28-client-migration.md`, which said to reject the keyword outright. **Does not change ADR-0094** (the read-only resource pin and the annotation condition both still apply). **Does not change ADR-0088** (`mcp.call` still stages an approval for every tool).

---

## Why this is a decision and not a bug fix

The unconditional refusal was deliberate. `docs/research/mcp-2026-07-28-client-opportunities.md` states the reasoning: "Do not let a server-authored schema silently create a new model-selected header channel", and "make an explicit policy choice before enabling modern calls". PR #607 implemented the safe first profile.

Two things about that profile were not known when it shipped.

**The refusal is load-bearing today, not a placeholder.** Alfred negotiates `versionNegotiation: { mode: "auto" }`, and GitHub supports `2026-07-28`, so Alfred was already making modern calls. The keyword gate was the only thing between a server's schema and the header channel.

**It also refuses GitHub's entire read-only catalog.** 21 of the 28 tools at `/mcp/readonly` declare `x-mcp-header` on `owner` and `repo`. So the whole catalog fails admission with `invalid_schema` on `get_commit`, whatever the OAuth consent screen granted. This was invisible until PR #958 widened the scope ask: the previous 8-tool catalog published only because none of those 8 tools used the keyword. Widening the scopes is what exposed the second gate behind the first.

So "leave the rule alone" is not a neutral option. It means the GitHub MCP catalog can never publish.

## What the era actually controls

The SDK gates the whole behavior on one condition:

```
const mirroringActive = this.getProtocolEra() === "modern" && detectProbeEnvironment() !== "browser";
```

In the legacy era the SDK builds no `Mcp-Param-*` header and the declaration is inert JSON on a schema keyword Alfred never reads. The channel the research note warns about does not exist there. Refusing the keyword in that era protects nothing and costs the catalog.

## Measured, 2026-09-03, against `https://api.githubcopilot.com/mcp/readonly`

| Configuration | Result |
| --- | --- |
| Modern era, raw descriptor | `list_branches` succeeds; the request carries `Mcp-Param-Owner` and `Mcp-Param-Repo` |
| Modern era, `x-mcp-header` stripped from the descriptor | `ProtocolError: header mismatch: missing Mcp-Param-repo header for parameter "repo"` |
| Legacy era, raw descriptor | 28 tools listed, NO `Mcp-Param-*` header sent, `list_branches` succeeds with `owner` and `repo` in the request body |

The live 28 descriptors were then driven through Alfred's own admission path:

| Era | Read-only pin | Resource | Result |
| --- | --- | --- | --- |
| legacy | on | `/mcp/readonly` | publishes 28 |
| modern | on | `/mcp/readonly` | refused, `invalid_schema` on `get_commit` |
| legacy | on | `/mcp` | refused, `write_tool` on `add_comment_to_pending_review` |
| legacy | off | `/mcp` | publishes 47 |

Row 1 is Alfred's configuration. Rows 2 to 4 are what keeps rows 1's admission from being vacuous.

## Alternatives

- **(a) Strip `x-mcp-header` from the descriptor at admission.** Rejected because it does not work. GitHub enforces the header in the modern era, so the call fails with a header mismatch. It would also make the stored descriptor differ from the wire truth, which is what `mcp_catalog_revisions.descriptors` exists to preserve.
- **(b) Admit the keyword in the modern era and accept the mirroring.** Deferred, not rejected. It needs a bound on header name and value size, and an argument that `Mcp-Param-*` cannot reach a credential, authorization, cache, proxy, or SSRF decision. The evidence is not bad — the SDK validates each declaration as an RFC 9110 token on a statically reachable primitive property, the `Mcp-Param-` prefix cannot collide with `Authorization`, Alfred's own `fetch` wrapper sets its headers last, the endpoint authorizer pins the URL, and the mirrored value is already in the request body. What is missing is a size bound on a model-chosen value. That is a separate decision with its own residual risk.
- **(c) Keep the unconditional refusal and give up on the catalog.** Rejected. It makes the reconnect pointless and ends the "MCP-only GitHub" direction by accident rather than on purpose.
- **(d) Pin the legacy era globally instead of per built-in.** Rejected. A user-added server has no `x-mcp-header` problem until it declares one, and the era condition already handles that case: such a server's descriptor is refused in the modern era, which is the correct answer for a server Alfred has not reviewed.

## What the legacy era costs

The modern era's per-connection features are what Alfred gives up on this one connection: the modern list-change subscription (Alfred sets `autoRefresh: false` and drives refresh itself, so this is a notification path, not a correctness one), the `_meta` protocol-version envelope, and modern cache-scope handling. Session termination moves back to the legacy `Mcp-Session-Id` path, which `SdkMcpProtocolClient.close` already implements. OAuth is unaffected: GitHub uses a static client id from the environment, not dynamic registration.

## What happens if GitHub drops the legacy era

`versionNegotiation: { mode: "legacy" }` asks for `2025-11-25` and nothing else. It is not a floor with a fallback. So if GitHub stops offering that version, the SDK finishes `connect` with no negotiated era, and `SdkMcpProtocolClient.connect` refuses:

```
McpClientError(unsupported_protocol_version):
  The MCP server did not negotiate the pinned legacy protocol 2025-11-25
```

The connection then goes to `failed` with that text in `lastError`, and the boss sees no GitHub MCP catalog at all. This is loud and it is the correct direction — the alternative is negotiating the modern era, in which 21 of GitHub's read-only descriptors declare a keyword Alfred refuses, so the refresh would fail one layer later with a message about `get_commit` instead. The named error is what keeps an operator from reading the outage as a transport bug.

There is no automatic recovery. Removing the pin is a code edit, and it is only safe once alternative (b) below is decided, because the modern era is exactly what the pin exists to avoid.

## Residual risk

- **The pin is per provider, so a second built-in that declares the keyword needs the same decision made again.** That is intentional. The field is on the definition so the answer is visible beside the endpoint it applies to.
- **Nothing gates the pin itself.** If GitHub stops declaring `x-mcp-header`, the pin becomes unnecessary and nothing will say so. The cost of leaving it is the feature list above.
- **The pin has no self-healing path.** The failure above needs a human, and nothing watches for it other than the connection row's status.
- **Alternative (b) stays open.** Until it is decided, Alfred cannot use a modern-era server that declares the keyword, and pinning the legacy era is the only way to read one.
- **This change adds no test**, per repository policy. The era condition is proved by the existing `rejects unsafe names and schemas before compiling the catalog` case, now negotiating the modern era, and by the live-catalog matrix above, captured in `references/scratch/probe-live-github-catalog-admission.ts`.
