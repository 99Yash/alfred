# ADR-0124 — Code Mode is the chat read path; writes stay direct calls until a bulk write needs ADR-0116

**Status.** Proposed; not built. Decided with the owner on 2026-11-11. Amends ADR-0087: the scope grows from context virtualization to the read path of chat, and handles (point 1) wait. Amends ADR-0116: its rejected alternative "MCP tools only through Code Mode" becomes the decision for reads, and its write path waits for the trigger below. ADR-0116 stays Proposed. The research behind it is [docs/research/polylane-blog-2026-11-11.md](../research/polylane-blog-2026-11-11.md).

**Decision in one paragraph.** The boss reads through one tool, `code.run`. Each read tool is a host function inside it: the curated tools, and the MCP read tools through the `mcp.read` and `mcp.describe` host functions of ADR-0116. A build step generates the index of host functions, with one line for each loaded tool and its output type from the TypeScript return type. A tool that returns binary data stays a direct call. A write stays a direct tool call with the approval gate that exists today. ADR-0116 is the write design, and a trace with a bulk write that a direct call cannot do well is the trigger to build it. The sandbox stays as ADR-0087 has it: `run`, QuickJS in WebAssembly, no network, and no credentials.

## Why

- **Composition is a fault in production, not a guess.** ADR-0087 said in July that multi-step composition was "speculative". The chat run `run_s7yi1ymxakcj` of 2026-11-08 is the run that started the memory theory. It made 41 `github.get_issue` calls, the context grew from about 8k to about 48k tokens, and the final turn took 125 s. In code mode, one script reads the issues, keeps the fields that it needs, and returns a summary.
- **A batch tool for each pattern is principle 1 in tool form.** The review of that run proposed a new `github.get_issues` batch tool. Each new fan-out pattern then needs one more tool. Code mode does the job for every read tool.
- **Polylane measured the same design.** In 30 days, more than 70% of its agent's tool calls ran in code, tool output in the context was about 14x smaller, and 98.8% of scripts succeeded. Its writes stay direct calls when a person is in the conversation. These are Polylane's numbers on its own setup, so they show the direction, not the size, for Alfred.
- **One foundation, two readers.** The memory check job (ADR-0123) needs a read-only `code.run` anyway. Chat then reads through the same path.
- **One read path.** If a read tool is both a direct tool and a host function, the model must choose between two paths. Principle 7 asks for the fewest parts.

## The decisions

1. **Chat reads only through `code.run`.** The boss gets no direct read tool that is also a host function.
2. **MCP read tools enter `code.run`.** When a tool has no output schema, the index says so. The model then uses `mcp.describe` and a first script that returns a short sample, and it writes the real script after it. This costs one more step for each untyped tool in a thread.
3. **Output types come from the TypeScript return types.** No curated tool has an `outputSchema` today. The compiler already knows each return type, so the index needs no new zod schemas.
4. **Binary results stay direct.** A script returns JSON only, so an image or a file comes back badly through it.
5. **Writes stay direct calls for now.** ADR-0116 stays the write design. Writes in the background, such as an agent that closes its own loop, also need the loop theory first.
6. **Discovery uses the lazy tool surface.** The `code.run` description holds the index of the loaded tools. `system.search_tools` stays for the tools that are not loaded.
7. **The prompt asks for safe scripts.** A `try/catch` around each call, `Promise.all` for calls that do not depend on each other, and a part of the time budget for each kind of tool. A failed call then costs a catch block, not a model step.
8. **Handles wait.** ADR-0087 point 1 is built only when a result still does not fit after a script trims it.

## Instrumentation

These rows start with the first slice, so the change is measured from day one:

- the share of chat reads that run in `code.run`,
- the script success rate, and the count of failed calls in scripts that still returned,
- the model steps and the context tokens for each turn.

The run `run_s7yi1ymxakcj` becomes an eval case: the same question must take fewer steps and less context. The ADR-0087 trajectory scorers (#898) grade the scripts offline with fake host functions.

## Alternatives

- **(a) Keep ADR-0087 as written, and fix fan-out with batch tools.** Rejected. It adds one tool for each pattern, and it leaves the 2026-11-08 shape for every tool that has no batch form.
- **(b) Handles first, then composition.** Rejected. Handles solve a large result. The fault in production is many small results.
- **(c) MCP tools stay direct calls, or enter code only when the server publishes an output schema.** Rejected. Both keep two read paths, and with the second one the server decides the path.
- **(d) Build ADR-0116 writes now.** Deferred, not rejected. Chat has a person in the conversation, and Polylane keeps writes direct in that case. The trigger is a bulk write that a direct call cannot do well.

## Residual risk

- An MCP server can change its result shape, and no type catches the change. The script then fails at run time, and its `try/catch` returns the results that it got.
- The quality of the code that `gpt-6-luna` writes for Alfred's tools is not measured yet. The instrumentation above measures it.
- A bulk write in chat needs a batch write tool for each case until ADR-0116 is built. Writes are much less frequent than reads.

## Cross-ref

Amends ADR-0087 and ADR-0116. Serves ADR-0123 (the check job). Uses the lazy tool surface (#405). Issue: #535. Theory: [docs/theory/README.md](../theory/README.md#4-what-to-work-on-next-foundations-first).
