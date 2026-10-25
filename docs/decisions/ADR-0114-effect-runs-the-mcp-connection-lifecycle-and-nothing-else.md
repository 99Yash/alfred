# ADR-0114 — Effect runs the MCP connection lifecycle, and nothing else (ACCEPTED — 2026-10-25)

**Problem.** `McpConnectionManager` (`packages/assistant/src/connections/mcp/manager.ts`) keeps one live MCP client for each connection. It starts the client, publishes its catalog, refreshes the catalog when the server says the tool list changed, and closes the client on a disconnect, a removal, a credential change, a failure, or a shutdown. Before this ADR, it did this with `async`/`await` and a hand-built state machine: a `phase` field, a `#catalogRefreshes` map, an `initializing` flag, and 26 checks that the generation is still open after an `await`. Each missing check let a closed generation publish a catalog or write a row.

Two bugs in one day came from this shape:

- PR #1511: `reconnect()` kept `auth_required` for one failure class only. An auth challenge restored the old status, so the card did not offer consent.
- A refused removal that races a start leaves a generation in the map with a rejected start. The connection stays `not_connected` until a reconnect or a restart. A probe proved it (`docs/research/effect-mcp-lifecycle-spike.md` §2.3).

**Earlier verdict.** In September, Alfred decided not to adopt Effect, also not for error handling only. The reason: an Effect island in a throw-based codebase gives two error models and a `runPromise` at each boundary. That verdict was not an ADR. This ADR reverses it for one module only, and keeps it for the rest of the codebase.

**Evidence.** Two spikes on `effect@4.0.6`:

- `docs/research/effect-mcp-reconnect-spike.md` (tagged errors on the reconnect path): a real but modest gain, at about +110 lines and a bridge at each Promise caller.
- `docs/research/effect-mcp-lifecycle-spike.md` (`Scope` and interruption on the generation lifecycle): 26 liveness checks to 0, `phase`, `#catalogRefreshes`, and `initializing` removed, 931 to 890 lines in the spike, the same 91 of 91 MCP tests passing with no test change. The built file has 934 lines: the persistence port (D3), the rules header, and the start cleanup (D5) add back what the spike removed. The gain is the 26 checks, not the length.

**Decision.** Effect runs the generation lifecycle inside `McpConnectionManager`. The rest of Alfred stays on `async`/`await`.

## D1 — The island is one file, and its public API stays `Promise`

- Only `packages/assistant/src/connections/mcp/manager.ts` may import `effect`.
- No exported type or signature of that file names an Effect type. Each public method returns a `Promise`, as before. The broker, the tool dispatcher, the HTTP routes, and the tests do not change.
- A second module that wants Effect needs its own ADR, or an amendment to this one with its own evidence.

## D2 — A generation is a `Scope`, and its work is fibers in that scope

- Each generation owns a `Scope.Closeable`. The client is acquired with `Effect.acquireRelease` into that scope, so the scope closes it.
- The start is one fiber. The catalog refresh is one fiber in the scope, and a `refreshDirty` flag coalesces a burst of list-change events. A caller's `prepareToolCall` or `refreshCatalog` runs as a fiber in the scope (`#runInGeneration`).
- A close interrupts the start, then closes the scope. That interrupts each fiber in the scope and then closes the client. A fiber stops at its next step after an interrupt, so no liveness check is necessary.
- A catalog fetch gets the fiber's `AbortSignal`, joined with the caller's signal, so a close cancels the HTTP request.

## D3 — A durable write cannot be interrupted, by construction

An interrupt abandons a pending promise, but the promise still runs. If a close abandoned a database write, the close could write `disconnected` and then the old write could land on top of it.

So code that runs in a lifecycle fiber reaches persistence only through a private Effect port. A read is interruptible. A write (`updateConnection`, `insertCatalogRevision`, `compareAndSetCatalogRevision`) is `Effect.uninterruptible`, so a close waits for a write that started. The decision is made one time for each persistence method, not at each call site.

The port covers the fibers only. Two kinds of write stay outside it:

- The public methods `reconnect`, `disconnect`, `remove`, and `rename` call the persistence object directly. They run outside any fiber, so no interrupt abandons their writes.
- The OAuth callbacks that `liveClientFactory` gives to the client (`onAuthorizationRequired`, `onInsufficientScope`) write `auth_required` from inside `client.connect` and `client.prepareToolCall`. They belong to the client, not to the lifecycle. See the residual risk below.

## D4 — The failure model does not change

- A start failure, a refresh failure, and a prepare failure throw the same errors as before (`McpClientError`, `McpOAuthAuthorizationRequiredError`, SDK errors). There are no tagged errors in this ADR. The first spike showed that they add a bridge at each caller for a smaller gain.
- At the `Promise` boundary, a fiber that ended by interrupt only becomes `McpClientError("not_connected")`. This is the error that the old liveness checks threw.
- A defect (a bug or a database error) rejects as itself.

## D5 — The removal fence gates admission only

`remove()` adds the id to `#removals` before the delete. The fence refuses new callers. It does not stop a start or a refresh that is in flight. If the delete succeeds, the `removal` close interrupts them. If the delete is refused, they finish normally. This removes the refused-removal bug: there is no longer a state where a start stopped but its generation stays in the map. Each start that fails (a read, the client factory, the connect, or the failure write) closes its scope and leaves the map, so the next caller starts again. An interrupted start does not leave the map itself: its close removes it.

## D6 — A lint fence keeps the island one file

- The root `no-restricted-imports` list gets a group for `effect` and `effect/*`. An override for `manager.ts` omits that group with an `oxlint-omission` marker, in the pattern that the other doors use.
- `check:oxlint-config` refuses a specifier that names no workspace package, because it cannot tell a live fence from a dead one. It learns one more tier: a bare specifier that a workspace `package.json` declares as a dependency is gated on that declaration. A fence on a package that no manifest declares still fails.
- `effect` is pinned exactly in the pnpm catalog and is a dependency of `@alfred/assistant` only. It runs on the server, so the web bundle does not change.

## Residual risk

- **Concepts.** A contributor to `manager.ts` must know that an interrupt abandons a promise, that a scope runs its finalizers in reverse order, and that `forkIn` on a closed scope interrupts at once. The file header states these rules.
- **Scheduler order.** The lifecycle tests control the interleaving with deferred promises, and they passed 15 runs in a row. They do not prove each interleaving that production can make.
- **Untested paths.** No test reaches the `auth_required` start path or the token renewal retry. They keep their old logic. The proof is the types and a read of the code.
- **A late OAuth callback write.** A close interrupts `client.connect` and abandons its promise. If the server then asks for consent, the client callback can still write `auth_required` after the close wrote `disconnected`. The old close waited for the whole start, so this window is new. It is small, because the callback must start after the close. The result is a card that offers consent for a disconnected connection, which a reconnect corrects.
- **A new persistence method.** D3 holds only if a new write goes through the port as uninterruptible. The port is in the same file, so a reviewer sees the choice. No gate checks it.

## Considered and rejected

- **Tagged errors on the reconnect path only (spike 1).** A real gain, but smaller than its cost, and it does not touch the lifecycle state.
- **An `AbortController` for each generation, with `signal.throwIfAborted()` after each `await`.** This is the same check at each `await` with a different name. Each missing line is still a bug.
- **`RcMap` for the client cache.** `RcMap.invalidate` does not close an entry that a caller holds, it removes the key at once (so a new start can begin while the old one closes), and it has no place for the close intent and the row write. The manager needs a closing tombstone and an ordered close.
- **Effect across `@alfred/assistant`.** No other module showed this kind of hand-built lifecycle state, and each new island adds a `Promise` boundary. One file with a lint fence keeps the cost bounded.
- **Keep `async`/`await` and fix the two bugs.** Each fix is small. But the 26 checks stay, and the next new `await` needs its own check.
