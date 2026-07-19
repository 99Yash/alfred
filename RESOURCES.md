# Alfred Harness Resources

## Knowledge

- [Alfred: The Boss Worker Harness](./docs/blogs/the-boss-worker-harness.md)
  Repository overview of durable runs, the boss/worker split, dispatch, scratchpads, and human gates. Use for orientation; verify details against source.
- [Alfred workflow types](./packages/api/src/modules/agent/types.ts)
  Primary local contract for workflows, steps, step results, and run lifecycle semantics.
- [Alfred executor](./packages/api/src/modules/agent/executor.ts)
  Primary implementation for leasing one step, executing it, and atomically committing its outcome.
- [Alfred chat workflow](./packages/api/src/modules/agent/workflows/chat-turn.ts)
  Primary implementation for the `chat-turn ↔ dispatch-tools` loop and chat-specific prompt stability.
- [Alfred LLM driver](./packages/ai/src/agent.ts)
  Primary implementation for one-request model turns and Anthropic cache breakpoints.
- [Alfred: Context working set / Code Mode / self-syncing — considered and shelved](./docs/plans/context-working-set-considered.md)
  Existing design map for parking large tool results, handle-based retrieval, sandboxed dataset code, and the boundary between Alfred and a Cloudflare execution substrate.
- [Anthropic: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  Provider documentation for prefix matching, explicit breakpoints, TTLs, ordering, and cache invalidation.
- [Anthropic: Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
  Primary documentation for caching tool definitions and preserving the prefix with deferred tool references.
- [Anthropic: Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
  Primary documentation for server-side BM25/regex discovery, <code>defer_loading</code>, and inline schema expansion.
- [OpenAI: Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
  Primary documentation for hosted and client-executed deferred tool discovery, cache preservation, namespaces, and model support.
- [Google: Function calling with Gemini](https://ai.google.dev/gemini-api/docs/function-calling)
  Primary documentation for Gemini custom tools and current active-tool guidance; use to verify whether native deferred discovery appears.
- [Google: Context caching](https://ai.google.dev/gemini-api/docs/caching/)
  Primary documentation for Gemini implicit caching and cache-hit accounting.
- [AI SDK: Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
  Upstream explanation of single versus multi-step model calls. Use to contrast SDK-owned loops with Alfred's runtime-owned loop.
- [MCP: Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
  Primary conceptual source for MCP's scope, host/client/server roles, protocol layers, primitives, lifecycle, discovery, and invocation flow.
- [MCP specification: Tools (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  Primary normative source for tool discovery, input/output schemas, errors, user-interaction guidance, and the security duties left to clients and servers.
- [MCP specification: Authorization (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  Primary normative source for remote-server OAuth, protected-resource discovery, audience-bound tokens, and scope minimization.
- [MCP: Security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
  Official attack-oriented guide covering confused deputies, token passthrough, SSRF, session hijacking, local-server compromise, and mitigations.

## Wisdom (Communities)

- Alfred's `decisions.md` and pull-request history
  Use when the source shape seems surprising: the design rationale and prior production failures explain many load-bearing choices.

## Gaps

- Add a real run trace from local observability after the source-level happy path is understood.
- Alfred's MCP backend remains deferred; when implemented, add one captured initialize → tools/list → dispatch → tools/call trace and compare it with the planned ADR-0018 lifecycle.
