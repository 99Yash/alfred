# Context working-set / Code Mode / self-syncing — considered & SHELVED (2026-06-27)

**Status: SHELVED.** No code. Re-open only when a real workflow hits the context wall (see trigger below). This doc preserves the design map so the thinking isn't lost.

## Where it started

Inspired by a dax (@thdxr) tweet about opencode's "system prompt facts that change without
breaking the cache" (e.g. `Today's date is now: …`). That led to a broader idea: the boss
transcript shouldn't be the working memory. Three things the user wanted to explore, which
turned out to be **one architectural family, not three**:

1. Compacting context mid-run.
2. The model emitting **artifacts** (huge or minor) that are NOT in context by default, looked
   up on demand ("write a script and take a look at it").
3. **Code Mode** (Cloudflare: https://blog.cloudflare.com/code-mode/ and /code-mode-mcp/) — the
   agent writes code against a typed tool API instead of chaining individual tool calls.

All three are the same move: **keep the context small and stable; push the bulk out-of-band;
reconcile on demand.** The unifying frame is the same one behind
`/Users/yash/Developer/oss/self-syncing-agent`: *the agent authors code once; the code runs
out-of-band; the LLM stays out of the hot path.*

## The family, ordered by sandbox ambition

| Level | What the boss can do | Sandbox needed | Cost / risk |
|---|---|---|---|
| **L0** | Park big tool results as objects; `read_object(handle, jsonpath, page)` to pull slices | **none** (structured query in our own code) | low / low |
| **L1** | Write a TS snippet that filters/maps/reduces **parked data only** — no network, no tools | data-only isolate (e.g. isolated-vm) | med / low-med |
| **L2** | Write code that calls tools/integrations as a typed API (real Code Mode) | isolate + capability injection + egress allowlist | high / high |
| **L3** | Author schema + webhook handlers that run inference-free at steady state (self-syncing) | full CF-style: V8 isolates, `globalOutbound`, per-facet SQLite, Worker Loader | very high |

The user's literal ask ("emit artifacts, write a script to look at them") is ~L1.

## Root goal (locked during grill)

**Context bloat / cost / latency** — huge tool outputs (e.g. a 200-email list) bloat the
transcript and get re-billed every subsequent turn. NOT "boss is bad at tool-chaining" and NOT
primarily "lossy compaction." This matters because it picks L0/L1 over L2.

## The load-bearing constraint (why we're shelving)

Every level above L0 requires **running agent-authored code safely out-of-band**, and that is
**free on Cloudflare and hard on Alfred.**

- self-syncing-agent gets V8 isolates per facet, `globalOutbound` egress control, per-facet
  SQLite, and Worker Loader *natively* — it's Cloudflare-built (~8k LOC, 206 tests, already
  working).
- Alfred is Node/Elysia on Railway. It has none of that. A sandbox there means isolated-vm /
  subprocess / microVM + capability injection + egress control = multi-week substrate project,
  high-risk surface.

User's call: **"if it's too costly we don't need to do it."** Correct.

### Strategic conclusion

The code-mode / self-syncing capability **already exists on the correct substrate.** Don't pay
the sandbox tax twice by re-implementing isolation in a Node monorepo. Keep self-syncing as its
**own product**; if Alfred ever needs "agent rides schema+handlers, inference-free," it should
**call that as a Cloudflare service**, not rebuild it in Elysia.

## What Alfred already has (recon, 2026-06-27)

- **Artifacts (ADR-0075):** out-of-band content model already shipped. Boss gets an ID only;
  content lives in Postgres + Replicache. (`packages/db/src/schema/artifacts.ts`,
  `packages/api/src/modules/artifacts/write.ts`, tools in `…/modules/tools/system.ts`.)
- **Mid-run compaction (ADR-0035):** already happens, token-estimate triggered after each tool
  batch — but it's **lossy** (LLM summary, irreversible). (`…/agent/compaction/compactor.ts`,
  trigger in `…/workflows/user-authored-brief.ts:238`.)
- **Scratch tools:** read/write/promote JSON, no execution.
- **Tool results → transcript:** full result enters the transcript; only the *client* event-bus
  preview is capped (`chat-turn.ts` `preview()` / `dispatchResultToToolOutput`). **No per-result
  byte cap on the transcript path** — this is the seam L0 would use.
- **Code execution / sandbox:** does **not** exist.

## If/when we re-open: the L0 slice (no sandbox)

Trigger: a real workflow demonstrably hits the context wall (boss turns ballooning from a
verbose tool result, pre-compaction, hurting latency/cost — verify in Langfuse, don't assume).

Sketch:
1. At the **dispatch boundary** (`packages/api/src/modules/dispatch/index.ts`), if a tool result
   exceeds a size threshold, persist the full result as an object and return a **preview +
   handle** into the transcript instead.
2. Reuse the existing `preview()` shape (caps arrays/strings/keys) for the inline preview; the
   preview must carry the handle + enough shape for the boss to decide whether to retrieve more.
3. Add a `read_object(handle, jsonpath?, page?)` retrieval tool (structured, no code execution).
4. **Compactor interaction (the wrinkle to get right):** the preview+handle is small and survives
   compaction fine, but ensure the compactor never summarizes away the handle — otherwise the
   boss loses the pointer to parked data. Mirror the existing "summary carries no cacheControl"
   discipline.
5. Object store: probably a new lightweight internal table (NOT artifacts — those are
   user-facing/Replicache-synced; NOT scratch necessarily). Per-thread or per-run lifecycle + GC.
6. Likely an ADR note: relaxes the current implicit invariant that the full tool result lives in
   the transcript.

Open decisions deferred with the shelving: bounding trigger (auto-by-size vs per-tool vs
hybrid), object-store substrate, lifecycle/GC, per-integration carve-outs (some results are
meaningless when truncated).

## Separately still open (smaller, unrelated to the sandbox)

The **original opencode SystemContext idea** — cache-preserving fact deltas (baseline fact in the
system prompt, "X changed" deltas in the transcript after the cache breakpoint). Small, surgical,
serves #223 and fixes `connected-summary` mid-run staleness (currently frozen for the whole run
by ADR-0053). Not part of this shelving — can be picked up independently. Its one wrinkle: a
delta living in the transcript can be summarized away by the compactor, reverting the boss to the
stale baseline fact; needs the compactor to re-emit current facts or post-compaction re-injection.
