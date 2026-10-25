# Spike: Effect for the MCP generation lifecycle

**Date:** 2026-10-25
**Branch:** `spike/effect-mcp-lifecycle`. The base is `25d676d76`, the head of PR #1511.
**Question:** The first spike (`docs/research/effect-mcp-reconnect-spike.md`, branch `spike/effect-mcp-reconnect`) found a modest gain for failure handling only. It left one test open: can Effect's `Scope` and interruption replace the hand-built lifecycle state machine in `McpConnectionManager` with less code?

## 1. Scope

The spike changes only `packages/assistant/src/connections/mcp/manager.ts`. The public API does not change: each method still returns a `Promise`, and every caller and test is unchanged. The failure model of PR #1511 does not change. This spike does not use tagged errors, so its result is independent of the first spike.

| Piece                    | Before                                                                                            | After                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Generation               | `phase`, `start: Promise`, `closeDone`, `closeIntent`, `closeFailure`                             | `scope: Scope.Closeable`, `start: Fiber`, `refresh: Fiber`, `closing`, `closeIntent`, `closeFailure`   |
| Liveness                 | `#assertOpenGeneration` / `#isOpenGeneration` / `#isReadyGeneration` after each `await`           | Interruption at each `yield*`. A close interrupts the start and each fiber in the scope                |
| Client release           | `client.close()` in four catch paths and in `#closeGeneration`                                    | One `Effect.acquireRelease` finalizer in the generation scope                                          |
| Catalog refresh          | `#catalogRefreshes` map, `CatalogRefreshState`, a reschedule in `finally`, a close-side wait loop | One fiber per generation, forked in the scope, with a `refreshDirty` flag                              |
| Caller prepare / refresh | Runs in the caller, and checks liveness after each step                                           | `#runInGeneration` forks it into the scope. A close interrupts it, and the caller gets `not_connected` |
| Durable writes           | Plain `await`                                                                                     | `write()` = `Effect.uninterruptible`. A close waits for a write that started                           |

## 2. Findings

### 2.1 The state machine gets smaller

| Measure                                                                                         | Before | After |
| ----------------------------------------------------------------------------------------------- | -----: | ----: |
| `manager.ts` lines                                                                              |    931 |   890 |
| Liveness checks (`#assertOpenGeneration`, `#isOpenGeneration`, `#isReadyGeneration` call sites) |     26 |     0 |
| `phase` references                                                                              |     13 |     0 |
| `#catalogRefreshes` references                                                                  |      7 |     0 |
| `initializing` flag references                                                                  |      4 |     0 |
| `generation.closing` checks (admission, ready lookup, refresh entry, refresh failure)           |      0 |     4 |
| `write()` sites (uninterruptible durable writes)                                                |      0 |     7 |

The file is 41 lines shorter. That includes about 25 new lines for the helpers (`step`, `write`, `closeQuietly`, `bothSignals`, `#settle`, `#runInGeneration`). The 26 checks are the main gain. Each one was a place where a missing line let a closed generation publish a catalog or write a row. In the Effect version, a fiber stops at its next step after an interrupt, so there is no line to forget.

### 2.2 The obligation moves from "check after each await" to "mark each write"

Effect abandons a pending promise when it interrupts a fiber. The promise still runs. If a close abandons a database write, the close can write `disconnected` and then the old write lands on top of it. So each durable write must be uninterruptible (`write()`), and then a close waits for it.

This is a smaller obligation than before: 7 write sites, against 26 await sites. It is also local: you decide it where you write the database call. But the compiler does not enforce it. A persistence facade that returns uninterruptible Effects would make it true by construction. This spike did not build that facade.

### 2.3 A real bug in the base code: a refused removal poisons the connection

`remove()` adds the id to `#removals` before the delete. A start that is in flight sees the fence at its next liveness check and throws `not_connected`. But that path does not delete the generation from `#generations`. If the delete then returns `blocked` (the removal gate refuses), no close runs. The generation stays in phase `starting` with a rejected promise, and each later `getReadyClient` returns that promise. The connection stays `not_connected` until a disconnect, a reconnect, a credential change, or a process restart.

A throwaway probe (start blocked in `connect`, then `remove()` with a delete that returns `blocked`) proves it:

| Step                          | Base (`25d676d76`)        | Effect spike |
| ----------------------------- | ------------------------- | ------------ |
| Start during the removal      | `rejected: not_connected` | `ready`      |
| First call after the refusal  | `rejected: not_connected` | `ready`      |
| Second call after the refusal | `rejected: not_connected` | `ready`      |

The same gap exists after `readConnection` in `#startClient`: that liveness check is outside the `try`, so it also leaves the generation in the map.

The fix in the spike comes from the design, not from Effect. The fence now gates admission only. A start or a refresh in flight continues during the delete. A successful delete closes the generation, and the close interrupts them. A plain fix in the base code is to delete the generation from the map in the not-open branches (about two lines).

### 2.4 Behavior changes

1. **A removal no longer stops a start or a refresh in flight.** Admission is still fenced. If the delete succeeds, the removal close interrupts the work. Its writes to the row wait for the delete transaction (the row is `FOR UPDATE` locked). Then an update changes no row, and a revision insert fails on the foreign key. If the delete is refused, the work finishes normally. This is the fix in 2.3.
2. **A close cancels a catalog fetch in flight.** `client.prepareToolCall` gets the fiber's `AbortSignal` (joined with the caller's signal). Before, the fetch ran to the end and its result was dropped.
3. **The refresh handler is registered when the generation becomes ready.** Before, it was registered at the start and ignored events until ready. The start loop already handles an earlier invalidation (`client.catalog` is cleared), so the result is the same. This change does not need Effect.

`McpRawClient` runs `connect` and `close` in one queue (`#runLifecycle`). So when a close interrupts a start during `connect`, the client close waits for the connect and then closes the transport. No transport leaks.

### 2.5 Costs

1. **New concepts for each reader.** A contributor must know that an interrupt abandons a promise, that `Effect.uninterruptible` protects a write, that a scope runs its finalizers in reverse order, and that `forkIn` on a closed scope interrupts at once. The old code is longer, but it uses only `async` and `await`.
2. **Two models inside one class.** The public methods are `async`. The internals are Effects. `#settle` maps a fiber `Exit` back to a result or a throw, and an interrupt becomes `not_connected`. `#closeGeneration` and `#waitForCatalogRefresh` call `Effect.runPromise`. There are six `runPromise` / `runFork` calls.
3. **A dependency.** `effect@4.0.6` in `@alfred/assistant`. It runs on the server only, so the web bundle does not change.

## 3. Verification

- `tsc --noEmit` for `@alfred/assistant` passes. `pnpm check` passes (section 6).
- The same seven MCP test files as the first spike ran against the local database: `manager`, `manager-lifecycle`, `broker`, `recovery`, `oauth`, `broker-policy`, and `tool-runtime/dispatch/mcp-seam`. Base: 91 tests, 91 pass. Spike: 91 tests, 91 pass, with no test change.
- `manager-lifecycle` and `manager` ran 15 times on the spike: 20 of 20 pass each time. These tests control the interleaving with deferred promises (close during start, refresh failure during disconnect, `closeAll` in each order, removal fence). So the Effect scheduler did not change an ordering that the tests check.
- The probe in 2.3 ran on both trees and was then deleted.
- No test reaches the `auth_required` start path or the token renewal retry. Those paths keep their old logic, and the types and a read of the code are the only proof.

## 4. Assessment

The first spike asked whether Effect can replace the lifecycle state machine with less code. It can. The 26 liveness checks go away, three pieces of state go away, and the refresh coordination becomes one scoped fiber. The file is also shorter. The remaining obligation (mark writes uninterruptible) is smaller and more local than the one it replaces.

Together, the two spikes show this:

| Spike                   | Gain                                                | Cost                                        |
| ----------------------- | --------------------------------------------------- | ------------------------------------------- |
| 1. Failure handling     | Each layer must handle each failure tag             | +110 lines, a bridge at each Promise caller |
| 2. Generation lifecycle | 26 liveness checks to 0, −41 lines, simpler refresh | New concepts, `write()` discipline          |

The lifecycle gain is the stronger one, and it does not need the tagged errors of spike 1. The two bugs that the spikes found (the auth-challenge gap in PR #1511, and the refused-removal poison in 2.3) are both in this class of code: state that hand-written control flow must keep correct after each `await`.

Recommendation: an Effect island in `McpConnectionManager` only, with the boundary at its public `Promise` API. Start with this lifecycle change. Add tagged errors (spike 1) only if a second layer needs them. Keep the rest of the codebase on `async`/`await`. This reverses the September decision for one module, so it needs an ADR.

## 5. Next steps

1. Decide on the island. If yes, write the ADR: the module boundary, the `write()` rule, and the interrupt-to-`not_connected` mapping.
2. Fix the refused-removal poison (2.3) now, in a small PR without Effect, or as part of the island PR.
3. If the island goes ahead, add the persistence facade from 2.2, so that each write is uninterruptible by construction.
4. If it does not, delete `spike/effect-mcp-lifecycle` and `spike/effect-mcp-reconnect`.

## 6. Gate

`pnpm check` passes. The first run failed only `format:check` on `manager.ts`. After `oxfmt`, `format:check` passes, and each gate before it in the chain (lint, knip, architecture, imports, consolidation) had passed.
