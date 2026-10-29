# Alfred as an MCP client

Alfred is a personal AI assistant at [alfred.beauty](https://alfred.beauty). It is
a remote MCP **client**. It connects to hosted MCP servers for the user, reads
their tool catalogs, and lets its agent call those tools. Alfred is not an MCP
server ([ADR-0018](../decisions/ADR-0018-mcp-scope-client-side-only-at-v1.md)).

This page states what a server operator sees when Alfred connects. Each claim
names the code that makes it true.

## Built-in servers

Alfred ships these MCP servers as built-ins. The endpoint, the resource, and the
client policy of each are fixed in code
(`packages/assistant/src/connections/mcp/constants.ts`,
`packages/assistant/src/connections/mcp/built-ins.ts`):

| Server   | Endpoint                                     |
| -------- | -------------------------------------------- |
| GitHub   | `https://api.githubcopilot.com/mcp/readonly` |
| Linear   | `https://mcp.linear.app/mcp`                 |
| Notion   | `https://mcp.notion.com/mcp`                 |
| Sentry   | `https://mcp.sentry.dev/mcp`                 |
| Polylane | `https://mcp.polylane.com/mcp`               |
| Railway  | `https://mcp.railway.com/mcp`                |

The user can also add a custom HTTPS MCP endpoint.

## Transport and protocol

- Transport: Streamable HTTP only.
- Protocol library: `@modelcontextprotocol/client` 2.0.0. It supports the
  protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and
  `2024-10-07`, and it negotiates the version with the server.
- Endpoint guard: Alfred accepts only a public `https:` endpoint with no
  fragment. It refuses a host that resolves to a private or internal address.
  It checks each redirect hop, keeps MCP traffic on the stored origin, and does
  not replay a redirected `POST` (`validatePinnedHttpsEndpoint`,
  `createGuardedFetch`, `packages/assistant/src/connections/hosted-endpoint.ts`).

## Authorization

Alfred implements the MCP authorization specification (2025-06-18 and later)
through the SDK `auth()` flow, with its own `McpOAuthProvider`
(`packages/assistant/src/connections/mcp/oauth.ts`).

1. **Discovery.** Alfred reads the server's protected resource metadata
   (`/.well-known/oauth-protected-resource`, RFC 9728). Then it reads the
   authorization server metadata (RFC 8414), with OpenID Connect discovery as
   the fallback.
2. **Client identity.** If the authorization server sets
   `client_id_metadata_document_supported`, Alfred uses a client ID metadata
   document. Its `client_id` is
   `https://api.alfred.beauty/api/integrations/mcp/client-metadata`, and that
   URL serves the document. If the server does not support it, Alfred uses
   dynamic client registration (RFC 7591) with the same metadata.
3. **Authorization request.** Alfred uses the authorization code grant with
   PKCE (`S256`). It refuses an authorization server that does not support
   `S256`. It sends the `resource` parameter (RFC 8707) on the authorization
   request and on each token request, so each token is bound to one MCP
   server.
4. **Callback.** The callback binds each attempt to a one-time `state` value
   (`oauthHandshake("mcp")`, `packages/assistant/src/connections/oauth-state.ts`).
   When the server sets `authorization_response_iss_parameter_supported`,
   Alfred compares the `iss` value byte for byte with the issuer (RFC 9207).
5. **Refresh.** Alfred refreshes a token before it expires. It starts a new
   consent only when it has no usable refresh token.

### Client metadata

This is the live document at the `client_id` URL:

```json
{
  "client_id": "https://api.alfred.beauty/api/integrations/mcp/client-metadata",
  "client_name": "Alfred",
  "client_uri": "https://alfred.beauty/",
  "redirect_uris": ["https://api.alfred.beauty/api/integrations/mcp/callback"],
  "application_type": "web",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Alfred is a public client. It holds no client secret unless a server issues one
at registration.

### Redirect URI

```
https://api.alfred.beauty/api/integrations/mcp/callback
```

The redirect URI comes from the server's `BETTER_AUTH_URL`
(`mcpOAuthClientConfiguration`). A local development server uses
`http://localhost:3001/api/integrations/mcp/callback`.

## Token storage

Alfred seals each access token, refresh token, and client secret with
AES-256-GCM before it writes the value to the database
(`packages/db/src/credential-envelope.ts`, `packages/db/src/schema/mcp.ts`).
The key-encryption key comes from the environment. Alfred has no plaintext
fallback, and the server does not start without the key.

## Tool calls

- Alfred sends each MCP tool call through one `mcp.call` tool. The approval floor
  of that tool is `high`, so the user approves each call to a tool that the user
  has not reviewed
  ([ADR-0088](../decisions/ADR-0088-the-mcp-call-approval-floor-is-a-floor-not-a.md)).
- The user can review one tool and give it a lower tier. That review binds to a
  hash of the tool descriptor. If the server changes the tool schema, the review
  stops and the approval comes back.
- When a server publishes a read-only resource, Alfred connects to that resource
  and not to the read-write one
  ([ADR-0094](../decisions/ADR-0094-mcp-read-only-surface-is-a-pinned-resource.md)).
  The GitHub built-in uses this.

## Contact

- Product: [alfred.beauty](https://alfred.beauty)
- Support: [alfred.beauty/support](https://alfred.beauty/support)
- Privacy policy: [alfred.beauty/privacy-policy](https://alfred.beauty/privacy-policy)
- Terms of service: [alfred.beauty/terms-of-service](https://alfred.beauty/terms-of-service)
- Source: [github.com/99Yash/alfred](https://github.com/99Yash/alfred)
