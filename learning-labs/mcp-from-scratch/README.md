# MCP from scratch lab

This zero-dependency lab implements the smallest useful slice of an MCP stdio connection without an SDK. It exists to expose the wire protocol; production code should normally use an official MCP SDK.

Run it from the repository root:

```sh
node learning-labs/mcp-from-scratch/client.mjs
```

Watch for three distinct conversations:

1. `MCP CLIENT → SERVER`: universal MCP JSON-RPC methods such as `initialize`, `tools/list`, and `tools/call`.
2. `HOST → MODEL` / `MODEL → HOST`: provider-specific model tool definitions and proposals. These are not MCP messages.
3. `HOST POLICY`: authorization, approval, and audit decisions owned by the host, not by MCP.

The server intentionally exposes a preview-only Calendar tool. It validates arguments and returns an MCP tool result but performs no external mutation.

Files:

- `server.mjs`: raw newline-delimited JSON-RPC server over stdin/stdout.
- `client.mjs`: launches the server, performs the MCP lifecycle, and simulates the host/model handoff.

Primary references:

- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
