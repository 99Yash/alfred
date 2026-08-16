# Server mutators

Server-side Replicache mutators run inside the push handler's transaction, one
savepoint per mutation. Keep that atomicity constraint local: a domain helper
that opens its own `db().transaction(...)` escapes the savepoint and does not
belong in a mutator body here.

One file per synced domain, plus `index.ts`, which is the registry and the only
door. `mutator.ts` holds the three shared types.

The `serverMutators satisfies Record<MutatorName, ServerMutator>` check in
`index.ts` is the module interface: a client mutator with no server
implementation must fail at compile time. Adding a mutator means one new
`export async function` in the domain file and one shorthand row in that
literal.
