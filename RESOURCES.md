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
- [Anthropic: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  Provider documentation for prefix matching, explicit breakpoints, TTLs, ordering, and cache invalidation.
- [AI SDK: Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
  Upstream explanation of single versus multi-step model calls. Use to contrast SDK-owned loops with Alfred's runtime-owned loop.

## Wisdom (Communities)

- Alfred's `decisions.md` and pull-request history
  Use when the source shape seems surprising: the design rationale and prior production failures explain many load-bearing choices.

## Gaps

- Add a real run trace from local observability after the source-level happy path is understood.
