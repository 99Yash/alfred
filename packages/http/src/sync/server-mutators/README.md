# Server Mutators

Server-side Replicache mutators run inside the push handler transaction. Keep
that atomicity constraint local to this module: domain helpers that open their
own `db().transaction(...)` do not belong in server mutator implementations.

The current entrypoint is `index.ts`, exported through the parent
`server-mutators.ts` shim so existing imports keep working. When adding new
mutators, group implementation by synced entity here before widening the parent
map:

- facts
- preferences
- action policy
- workflows
- todos
- chat
- triage tags

The exported `serverMutators satisfies Record<MutatorName, ServerMutator>` check
is the module interface: a client mutator without a server implementation must
fail at compile time.
