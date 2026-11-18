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

## Amendment 2026-11-18: the read route, read authority, and the evidence record

Decided with the owner after two reviews of #1776. The route had three patches, so the theory is written first (theory README, principle 2). This amends decisions 1, 2, and 4.

**One route decision for each call.** After the existing checks, the tool runtime decides the route of each call with this table:

| Call                                                    | Route                                 |
| ------------------------------------------------------- | ------------------------------------- |
| A write, or a call whose effect is not confirmed        | Direct, through the existing approval |
| A confirmed read with binary output                     | Direct                                |
| A confirmed read that requires approval                 | Direct, with its card                 |
| A confirmed read with structured output and no approval | Script                                |

- The approval input includes the staging arm and the thread's Full Autonomy. Thus a local `fast_path` catalog read is a script read.
- Search reports the current decision. Dispatch decides again. The broker checks the current descriptor and the read authority before delivery.
- A policy can change between search and dispatch. So a refusal returns the current route and its reason.
- The connected summary describes capabilities and the read-route rule. It does not select read routes from approval settings captured at run start. Existing write approval labels remain confirmation hints under ADR-0069. Dispatch evaluates approval when each call runs (owner, 2026-11-18).

**Read authority is independent of the server.** A call is a confirmed read only with one of these:

- a trusted built-in read-only endpoint, together with the tool's published read-only hint, or
- an exact read policy bound to the descriptor, from Alfred's built-in code or approved by the owner.

The hint of a custom server alone leaves the effect unknown. A change of the descriptor needs a new authority decision. Full Autonomy can waive the approval, but the script-read rule still applies. A descriptor pin records the approval of an exact interface. The behavior of the server stays a trust assumption, because MCP treats annotations as hints.

**The output kind is declared beside the read authority.** Alfred declares it for a curated tool. A built-in MCP tool keeps it in its descriptor-bound policy. A custom tool needs a trusted declaration before its output can enter a script. The declaration can depend on the validated input. A tool with no output schema can still have a known structured kind. Base64 file content is binary, so Drive's `download_file_content` is direct. A response that does not match its declared kind returns a named failure.

**The sources of a script.** The host collects them, and they do not depend on the script's status:

- The sources of successful reads stay after a later script failure.
- The sources have a count limit and a byte limit. Each kept URL is complete, and the result states how many were left out.
- The UI gets the sources through a field that the generic preview does not prune.
- The full model-facing envelope stays within its result budget.

**The evidence record.** Each program run keeps a record, so Alfred can explain and check what happened. The record holds the program source, the arguments, the tool identities, the evidence references, and the outcome. Failed and partial runs keep a record too. For each host call, it holds the function, the canonical arguments, the call identity, the outcome, the evidence references, and the content hashes or versions. It also records pagination and truncation where they change the coverage. A replay keeps the references and versions of the saved result. The existing staging and invocation rows carry the facts that they hold. The read boundary adds the missing fields, and each reader supplies its own evidence references. A search hit proves that the program got a title or a snippet. A body read proves that it got the body. The check job validates a citation against the content that the host delivered (memory.md).

**The default stays an experiment.** Every eligible read goes to a script while the flag is off. A paired evaluation decides the production default: the same tasks and provider responses in both modes. It covers single lookups, large single results, fan-out, dependent reads, and Gated reads. It measures answer quality, latency, total tokens, model steps, and approval effort. A route chosen from the expected fan-out is rejected, because it adds a judgment to the runtime.

**A saved program for reuse is a separate feature.** A completed run proves only that the program ran. A saved skill also needs evidence that it does the intended job, and rules for selection, version changes, and new approval checks. It waits until repeated tasks show a need.

## Amendment 2026-11-18 (b): the findings of the paired evaluation

The first paired evaluation (PR #1784; receipt in `docs/plans/code-mode-object-handles-v1.md`) found four product faults. The owner settled them on 2026-11-18. Findings 2 and 3 amend ADR-0096, ADR-0088, and ADR-0116. This amendment holds findings 1 and 4.

**Gated reads stay direct.** A Gated integration asks for approval before each action, and reads too. The read route sends a read that waits for a card to the direct path. Thus Code Mode helps only on an Auto integration. This is a limit of the design, not a fault. The evaluation uses the owner's production rule.

**The size bound applies at the boundary of the recipient.** ADR-0074 bounds an untrusted provider body "before the model sees it". The MCP client applied the bound to each call, so a script got a string of at most 8,000 characters. Thus no script could read a large single result. The decision:

- The MCP client still sanitizes the content (it removes NUL and lone surrogates).
- A direct `mcp.call` keeps all the ADR-0074 bounds before the model sees the result: 8,000 characters for each string, 50 items for each array, and 32 KiB for the body.
- A script read gets the full sanitized response, up to 1 MiB (`HOST_READ_DELIVERY_MAX_BYTES`). The check runs before the nested result is saved. A larger response saves the named failure `output_too_large`, so a replay returns the same failure.
- The content hash covers the sanitized value that the script gets. Provider pagination and provider truncation are recorded separately. Alfred's own cut is gone, but that does not prove that the provider returned everything.
- The full model-facing `system.code_run` envelope (the value, the sources, the counts, and the messages) is checked against its 64 KiB budget. `boundToolResult` clips only strings, so it is not that check.

**The storage bound.** One script can make 256 host calls (`maxBridgeRequests`). Thus one script can save about 256 MiB of accepted responses, before database overhead. The evidence record keeps the saved bytes of each host call, so the real size is measured.

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
