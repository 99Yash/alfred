# Elysia patterns

Elysia processes requests: `onRequest → transform → beforeHandle → handler → afterHandle → mapResponse → afterResponse`. Errors from any stage after routing jump to `onError`.

Key patterns in this repo:

```ts
// Auth guard via macro (packages/http/src/middleware/auth.ts)
app.use(authMacro).get("/protected", ({ user }) => user, { auth: true });

// Global error handler (packages/http/src/middleware/error-handler.ts)
// Normalises all errors to { error: string, code: string }.
// Throw an Errors.* factory from services; do not set.status manually.
// throw Errors.NotFoundError("Thread not found");
// Catch by code, not by class: if (isApiError(err, "CONFLICT")) …

// Session cache (packages/http/src/middleware/session-cache.ts)
// Call getSessionCached(request) — never auth().api.getSession() directly.
```

Plugin scope: hooks registered via `.use(plugin)` apply to routes defined after that call. Use `{ as: 'global' }` on `onError` to catch errors from all plugins.

## Response shapes

There is no shared envelope type. Errors already have one shape (`{ error, code }`, above). Success bodies follow these rules, and Eden carries each shape to the web client as a type:

- **Bare acknowledgment.** A mutation with nothing to report returns `{ ok: true }`. A delete also echoes the id: `{ id, ok: true }`.
- **Several outcomes.** When a success can end in more than one way, return one `status` discriminant and the fields each variant needs: `{ status: "queued", slot, runId }`, `{ status: "restaged", runId }`. Do not put `ok: true` beside `status`. An expected failure that the client renders is a variant too (`{ status: "failed", failure }`). Other failures are thrown `Errors.*`.
- **Id fields.** `id` is the resource the path addresses (the `:id` segment). Qualify every other id by its kind: `runId`, `jobId`, `connectionId`.
- **Lists.** Wrap the array in an object, never a bare array, so a field can be added later. A cursor page is `{ items, nextCursor }` plus page-level counts if needed. A one-shot list uses its plural noun (`{ connections }`, `{ shares }`). A keyed map is not a list (`{ tiers }`).

Known exceptions: the chat turn-start route and `POST /api/integrations/mcp/connections` name their discriminant `outcome`, and the MCP recovery page names its array `operations`. Each is a single consistent shape that a contract schema or a shared producer owns, so a rename is churn with no reader gain.

Exempt by design: webhook receivers (`/webhooks/*`) answer the external sender, not the web client. `/health` and `/ready` answer probes. Replicache pull/push follow the Replicache protocol, and SSE streams send events, not bodies.
