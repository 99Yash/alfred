# Spike: Effect for the MCP reconnect failure path

**Date:** 2026-10-25
**Branch:** `spike/effect-mcp-reconnect`. The base is `1de8df42a`, the commit of PR #1511.
**Question:** PR #1511 sends a connection with an unopenable secret to consent. To do that, it lets one error class through three `catch` blocks by hand. Does Effect make this kind of failure handling better, and what does it cost?

## 1. Scope

The Effect checkout at `~/.local/share/effect-solutions/effect` is the library source (`4.0.0-beta.85`). It has no MCP client and no OAuth client. Its only MCP code is `unstable/ai/McpServer.ts`, which is the server side. So there is no implementation to port. Only the error model can transfer.

The spike uses `effect@4.0.6` (latest stable, in the pnpm catalog). It rewrites one call chain:

| Piece                                                          | Before                                                                                  | After                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /connections/:id/reconnect` (`packages/http/src/mcp.ts`) | `try`/`catch`, `instanceof McpOAuthAuthorizationRequiredError`, `boolean` for not found | `catchTags` on three tags, `satisfies Effect.Effect<unknown, ApiError>`                |
| `McpConnectionManager.reconnect`                               | `Promise<boolean>`, catch everything, rethrow one class                                 | `Effect<void, McpConnectionMissing \| McpAuthorizationRequired \| McpReconnectFailed>` |
| `getReadyClient` / `#startClient`                              | one `catch` that sorts by `instanceof` and writes the row                               | `readyClient()` Effect. `#settleFailedStart` has one handler per row state             |
| Failure types                                                  | `Error` subclasses and `McpClientError` codes                                           | `Data.TaggedError` classes in `start-failure.ts`                                       |

`getReadyClient` keeps its `Promise` signature. The broker, the tool dispatcher, and the tests still call it. It runs the Effect and maps each tag back to the error that callers caught before (`#thrown`).

The OAuth provider (`oauth.ts` `#opens`) is not changed. It is a synchronous vault call with one `catch`. Effect adds nothing there.

## 2. Findings

### 2.1 The typed channel found a gap that PR #1511 did not close

`#startClient` writes `auth_required` in two cases: for `McpOAuthAuthorizationRequiredError`, and for a credentialed connection that gets an authorization challenge (`isMcpAuthorizationChallenge`, for example an SDK `UnauthorizedError` or a 401). Then it rethrows the original error.

PR #1511 makes `reconnect()` keep `auth_required` only for the first class (`manager.ts:425` at `1de8df42a`). In the second case, `reconnect()` restores the old status over `auth_required`, and the route returns a 400. The card does not offer consent.

In the spike, `classifyStartFailure` gives both cases one tag, `McpAuthorizationRequired`. The row stays `auth_required`, and the route returns `{ status: "auth_required" }`. The compiler does not prove this fix. One tag for one row state makes the fix the natural result.

This gap is real without Effect. A plain fix in PR #1511 is to test `needsMcpReauthorization`, or the same two conditions, in `reconnect()` and in the route.

### 2.2 The compiler checks that each failure has a handler

Two mutation probes, each reverted after the run:

- Remove the `McpReconnectFailed` handler from the route. Result: `TS1360`. `Effect<…, ApiError | McpReconnectFailed>` does not satisfy `Effect<unknown, ApiError>`.
- Remove the `McpStartInterrupted` handler from `reconnect()`. Result: `TS2375`. The declared return type rejects the extra tag.

So a new start failure tag fails `check-types` in each layer until that layer handles it. Today, the same change compiles and goes to the generic `catch`. That is how the PR #1511 bug happened.

### 2.3 Costs

1. **Size.** `manager.ts` has 260 lines added and 151 removed, so it is about 110 lines longer. `start-failure.ts` has 79 new lines. The route has 19 lines added and 17 removed. Some of this is the rewrite, but `Effect.gen({ self: this }, function* () { … })` in a class method adds lines that `async` does not.
2. **Two error models at the boundary.** Promise callers need `#thrown` and `Effect.runPromise`. In v4, `runPromise` rejects with the raw failure value, with no wrapper. That makes the bridge small, but each Promise caller still needs it.
3. **The SDK seam still uses `instanceof`.** The MCP SDK throws untyped errors and calls our `OAuthClientProvider` through Promises. `classifyStartFailure` keeps the class tests. Effect moves them to one place. It does not remove them.
4. **Defects and failures are different channels.** The old `reconnect()` restored the row on every throw, also a database error. To keep that, the spike uses `Effect.onError` with `Cause.findErrorOption`. That is correct, but it is less obvious than the old `catch`.
5. **One behavior change.** The old route turned every throw into a 400. Now a defect (database down, bug) rejects as itself, so Elysia returns a 500. A typed failure still returns 400 or 404. This is more correct, but it is a change.
6. **Shared start.** Concurrent callers shared a `Promise<McpRawClient>`. Now they share a `Promise<Exit>` from `Effect.runPromiseExit`, joined with `Effect.flatten`. The behavior is the same, but it is one more concept.

## 3. Verification

- `tsc --noEmit` passes for `@alfred/assistant` and `@alfred/http`. `pnpm lint` passes.
- These MCP test files ran against the local database on the spike and on the base commit: `manager`, `manager-lifecycle`, `broker`, `recovery`, `oauth`, `broker-policy`, and `tool-runtime/dispatch/mcp-seam`. Both trees: 91 tests, 91 pass, 0 fail.
- The tests reach the `failed`, `not_connected`, and `catalog_stale` branches of the start. **No test reaches `auth_required`, the token renewal retry, or `reconnect()`.** Those three paths are proved only by the types and by reading.

## 4. Assessment

On this one path, Effect gives a real gain: the failure list is in the type, and each layer must handle it. The cost is also real: more lines, a bridge at each Promise caller, and an SDK seam that does not change.

A discriminated union return (`ready | auth_required | failed`) would give most of 2.2 for this path, without a dependency. Effect gives more when failures go through many layers, because `yield*` carries the union with no manual code in each layer.

This spike does not test the larger possible gain. The manager has a lifecycle state machine that it controls by hand: the `#generations` map, `phase`, `closeDone`, `closeIntent`, `#catalogRefreshes`, and the open-generation checks after each `await`. Effect's `Scope`, interruption, and `Deferred` are made for that kind of code. If Effect can replace that state machine with less code, the case for an Effect island in the MCP subsystem is strong. If it cannot, this spike shows that the gain is only for failure handling, and the September decision stays correct.

## 5. Next steps

1. Fix the gap in 2.1 in PR #1511 now, without Effect. It is a real bug, and the fix is small.
2. Run a second spike on the generation lifecycle (`#readyClientOnce`, `#closeGeneration`, catalog refresh) with `Scope` and interruption. Compare the size and the number of open-generation checks.
3. If the second spike removes state, write an ADR for Effect in `packages/assistant/src/connections/mcp/`. Put the boundary at the manager's public API. If it does not, delete this branch.
