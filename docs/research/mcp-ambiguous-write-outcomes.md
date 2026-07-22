# Ambiguous MCP write outcomes: established patterns and an Alfred design

Status: researched 2026-07-22  
Scope: cancellation/timeouts around mutating `tools/call`, durable outcome
representation, retry safety, server idempotency, and reconciliation. This note
does not propose implementation changes outside that seam.

## Executive conclusion

This is a standard distributed-systems failure mode, not an MCP-specific oddity.
Once a mutating request may have reached the remote application, a client that
lost the response cannot infer whether the effect happened. There is no general
client-only way to manufacture exactly-once execution after that point.

The established solution is a small **operation ledger** plus one of three
recovery mechanisms:

1. Retry with the **same remote-recognized idempotency key** under a documented
   server guarantee.
2. **Reconcile** using a stable remote operation/resource/business identifier.
3. If neither is available, persist **outcome `unknown`** and block automatic
   repeats until a user or reviewed policy resolves it.

Alfred's local `tool_call_id` or `invocationKey` can stop Alfred from dispatching
the same local attempt twice, but it cannot deduplicate work inside a remote MCP
server unless the server receives and honors that identity. The existing
requirements already state the correct safety rule: cancellation is advisory
and a timed-out write is an unknown outcome
([requirements, line 57](./mcp-raw-client-v1-requirements.md#connection-and-session-lifecycle));
base `tools/call` has no protocol idempotency key, so automatic retry requires a
reviewed remote guarantee or conclusive reconciliation
([requirements, line 114](./mcp-raw-client-v1-requirements.md#tool-annotations-and-risk-policy)).

## What the owning standards say

### MCP: cancellation does not establish non-execution

The current MCP cancellation specification says receivers **may ignore** a
cancellation when processing already completed or cannot be cancelled. It also
calls out the race in which cancellation arrives after processing or even after
the response was sent. The cancelling sender should ignore a later response.
Those rules make the local timeout/cancel boundary insufficient evidence about
the remote effect
([MCP cancellation behavior](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation#behavior-requirements)).

MCP also tells clients to implement tool-call timeouts, but `tools/call` itself
contains only a tool name and arguments; there is no standard operation or
idempotency key in the base call
([MCP calling tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)).
Tool annotations cannot fill this gap: the specification requires clients to
treat annotations as untrusted unless they come from trusted servers
([MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool)).

### HTTP: do not automatically retry non-idempotent work without proof

HTTP Semantics gives almost exactly Alfred's required rule. A client should not
automatically retry a non-idempotent request unless it knows the request is
idempotent or can detect that the original request was never applied. The same
section explicitly presents checking target resource revisions after a failed
connection as a recovery technique
([RFC 9110, section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)).

gRPC follows the same boundary. Its automatic "transparent retry" is limited to
cases where the RPC never left the client or reached the server library but was
not seen by application logic. Broader retries require an explicit per-method
policy
([gRPC retry guide](https://grpc.io/docs/guides/retry/#transparent-retry)).
The useful abstraction is therefore not "network error = retryable" but
"provably not delivered = retryable; possibly delivered = policy-dependent."

### Server-recognized operation identity is the common elegant path

Stripe stores the first result for an idempotency key and returns that result to
later requests with the same key; it also compares parameters to prevent reuse
of a key for a different operation. Its guidance explicitly treats connection
errors as safely retryable only with the same key
([Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)).
Stripe separately warns that a new key is unsafe after an indeterminate result
because the original key may already have produced side effects, and recommends
local identifiers plus webhooks for later reconciliation
([Stripe advanced error handling](https://docs.stripe.com/error-low-level#idempotency)).

AWS uses the same contract under the name `clientToken`: same token plus same
parameters returns the original result without another action; changing
parameters produces a conflict; and the guarantee has a documented scope and
TTL
([Amazon ECS idempotency](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ECS_Idempotency.html)).
Google's API design guidance likewise says that supplying `request_id` must
guarantee idempotency and that duplicate requests should return the prior
successful response
([Google AIP-155](https://google.aip.dev/155)).

These contracts have four details Alfred must know before declaring a remote
write retryable:

- the server actually receives the key;
- the key's scope (account, region, resource, tool, and so on);
- the retention window/TTL; and
- the server rejects the same key with different effective parameters.

A trusted `idempotentHint` alone proves none of those details. It may establish
that repeated identical arguments have the same intended effect for a reviewed
tool, but it is not a remote replay token and does not recover the original
response.

## MCP Tasks help, but are not a complete answer

MCP Tasks are durable, pollable state machines for deferred results and are
currently experimental. A task-augmented `tools/call` returns a server-generated
task ID, after which the client can poll `tasks/get` and retrieve the eventual
tool result through `tasks/result`
([MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#creating-tasks)).
This is the MCP-native equivalent of Google's long-running operation resource,
which returns a durable name/token that clients poll later
([Google AIP-151](https://google.aip.dev/151)).

Tasks improve recovery **after Alfred has durably received the task ID**. They do
not close two important gaps:

- If the initial task-creation response is lost, the receiver-generated task ID
  may also be lost, so Alfred still cannot identify the operation merely from
  the base call.
- MCP says a cancelled task must remain `cancelled` even if execution continues
  to completion or failure. Therefore `cancelled` does not prove that a remote
  write had no effect
  ([MCP task cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-cancellation)).

Use task augmentation when supported, persist the task ID before returning
control, and poll it instead of issuing a new `tools/call`. Still retain the
unknown-outcome path for a lost creation response and for cancellation races.

## Recommended Alfred model

### Separate local execution lifecycle from remote effect outcome

One overloaded `status='failed'` cannot honestly represent this situation. Keep
two concepts distinct:

| Concept | Example values | Meaning |
|---|---|---|
| Local attempt lifecycle | `staged`, `sent`, `response_received` | What Alfred knows it did |
| Remote effect outcome | `succeeded`, `rejected`, `failed`, `unknown` | What Alfred can prove about the effect |
| Retry disposition | `safe`, `blocked`, `reconcile`, `same_key_only` | What the broker may do next |

The exact schema can remain smaller than this table. In Alfred's current model,
recording the action staging as `executed` is semantically reasonable if that
status means "execution was attempted," while a persisted broker envelope says
`outcome: 'unknown'`. What must not happen is mapping an abort/timeout to a bare
failure that both implies non-application and invites model self-correction.

The model-visible result should be explicit and non-actionable as an ordinary
retry error, for example:

```json
{
  "outcome": "unknown",
  "retry": "blocked",
  "message": "The remote write may have completed. Do not repeat it until its state is checked."
}
```

### Make the retry barrier durable and operation-scoped

Create the invocation/operation row **before** network dispatch, and persist at
least:

- owner, connection, remote tool, catalog/policy revision;
- canonical argument hash;
- local operation-intent ID and all local `tool_call_id` attempts attached to it;
- whether bytes may have reached the remote application;
- remote idempotency key, task ID, or business correlation ID when available;
- effect outcome, retry disposition, timestamps, and reconciliation evidence.

For a mutating call that times out after possible delivery, atomically move the
operation to `outcome='unknown', retry='blocked'`. Before any later execution,
the broker checks for an unresolved unknown with the same owner, connection,
tool identity, and canonical arguments. A fresh model `tool_call_id` must not
bypass that check.

Do **not** make `(connection, tool, args_hash)` permanently unique. Identical
arguments can be a legitimate later user intent (for example, sending the same
message twice on purpose). The useful constraint is a partial barrier while the
matching ambiguous operation is unresolved, plus an explicit new-intent path.
A safe shape is conceptually:

```sql
unique (owner_id, connection_id, remote_name, args_hash)
where effect_outcome = 'unknown' and resolved_at is null
```

The actual concurrency mechanism can be a partial unique index, transactional
reservation, or advisory lock. The invariant matters more than the mechanism:
only one unresolved ambiguous operation may silently match a new model proposal.
An explicit user-confirmed new action can receive a new operation-intent ID; the
model must not mint that distinction for itself merely by changing
`tool_call_id`.

### Recovery ladder

For each reviewed mutating remote tool, select the strongest supported path:

1. **Same-key replay.** If the remote API/server honors a documented idempotency
   key, generate it before dispatch, persist it, and reuse that exact key and
   effective payload for every retry. Never replace it with a fresh key.
2. **Poll a durable operation.** If task augmentation succeeded and its task ID
   is known, use `tasks/get` / `tasks/result`; do not reissue `tools/call`.
3. **Read-after-write reconciliation.** Query by a stable remote resource ID,
   client-chosen business key, or correlation metadata. Resolve to `succeeded`
   only when the remote contract makes the evidence conclusive. Eventual absence
   is not proof of non-application.
4. **Explicitly blocked unknown.** Surface "may have happened," stop automatic
   execution, and offer a user-visible check/reconcile action. "Retry anyway"
   must be an explicit new intent or reviewed operator decision, never model
   self-repair.

Declarative APIs make step 3 especially natural: controllers repeatedly compare
desired state with observed state and act only on the difference
([Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/)).
For imperative MCP tools without a stable lookup or idempotency key, the blocked
unknown is not inelegant accidental complexity; it is the honest limit of the
remote contract.

## Practical policy matrix

| Evidence after timeout | Automatic action |
|---|---|
| Broker proves request never reached application logic | Retry may be safe |
| Reviewed natural idempotence of the operation | Retry under that scoped policy |
| Persisted remote idempotency key within its TTL | Retry only with the same key and payload |
| Known MCP task ID | Poll/retrieve; do not re-call the tool |
| Reconciliation proves effect applied | Mark succeeded; do not retry |
| Reconciliation proves effect absent under a strong contract | Mark not applied; retry as policy permits |
| No conclusive evidence | Keep unknown and block automatic retry |

## Consequences for the current proposal

The recommendation already recorded in
[`mcp-persistence-broker-nuances.md`](./mcp-persistence-broker-nuances.md#7-idempotency--timed-out-write-durably-marking-unknown-and-never-silently-retrying)
is directionally correct: catch timeout/abort into a model-visible unknown
envelope, persist it as an attempted execution, and enforce suppression in the
MCP broker across fresh `tool_call_id` values.

One refinement is important: treat the argument fingerprint as an **unresolved
unknown barrier**, not as a permanent global deduplication identity. The durable
operation-intent ID owns retries; the argument fingerprint detects a model's
likely silent re-proposal. Reconciliation, same-key replay, or an explicit new
user intent releases or bypasses the barrier in an auditable way.

That yields the elegant invariant:

> Alfred may repeat a possibly delivered write only when the repetition is the
> same remote operation by contract, or when evidence shows that the first
> operation did not take effect. Otherwise the operation remains visibly
> unknown.
