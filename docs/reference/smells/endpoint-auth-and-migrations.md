---
id: endpoint-auth-and-migrations
section: Backend
status: stays-review
rung: none
---

# Give a new endpoint the auth and rate limit of its group.

Run `db:generate` then `db:migrate`, never `db:push`.

Why: an uncovered route is open. See [elysia.md](../elysia.md) and [database.md](../database.md).

## Bad

```ts
export const notesRoutes = new Elysia({ prefix: "/api" })
  .get("/notes", async ({ query }) => await listNotes({ userId: query.userId }));

// Then: pnpm --filter @alfred/db db:push
```

## Good

```ts
const ownerNotesRoutes = new Elysia({ prefix: "/api", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app.get("/notes", async ({ user }) => await listNotes({ userId: user.id })),
  );

// Then: pnpm db:generate && pnpm db:migrate
```

## Mechanism

Each needs knowledge of intent that the code does not state. `db:push` is a command that someone runs, not a fact in the source.

## Hits
