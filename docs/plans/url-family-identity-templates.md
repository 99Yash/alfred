---
status: proposed
evidence: "Read-only replay of 35 days of production Gmail (995 mails) on 2026-10-25. The draft harness and templates are in the gitignored references/scratch/lifecycle-replay/. No runtime change."
---

# URL-family identity templates

Alfred must connect related mails about one thing, for example a payment request and its receipt, or three failure mails about one deploy. Each integration and each industry puts the identity of a thing in a different place. This plan makes that place reviewed data. A deterministic back-test checks it on real mail before the owner approves it. The consistency gates alone do not prove that related mail joins; known pairs need explicit controls.

The plan extends the current registry: `ObjectKindDef.identity` and `IdentityAttribute.linkLabel` in `packages/contracts/src/integration-objects.ts` (ADR-0109 rule 2). It adds no second registry.

## 1. Evidence

A vendor-agnostic join on rare ID-like URL tokens made 131 joins between threads. Sixteen touched an open loop, and about three of those were correct. Each wrong join came from a container id:

| Source | Container that joined unrelated mail | Where the item identity is |
| --- | --- | --- |
| Stripe hosted invoice | Account id, in the path and inside the encoded token | Second field of the base64url token after the account segment |
| Railway build failure | Project, service, and environment ids | `id` query parameter (deployment); the three ids name the target |
| Linear notification | Workspace id in the query | Not in this sample |
| GitHub Actions | Owner and repo | `runs/<run_id>`; a re-run keeps the same `run_id` |

Cross-thread joins are rare: about three correct joins in 169 open-loop mails. Most lifecycle evidence is inside one Gmail thread or in provider state. A provider read when a reader shows the item gives more value than more mail rules.

## 2. What the current registry cannot express

`parseProviderLink` labels each path value with the segment before it, and each query value with its parameter name. That covers Railway and Sentry. It cannot express:

1. **A value after a variable segment.** In Stripe's `/i/<account>/<token>`, the segment before the token is the account id, so no fixed `linkLabel` names it.
2. **An encoded value.** The Stripe token is base64url text plus binary bytes. The invoice token is one field inside it.
3. **The lifecycle of a kind.** An invoice or a deploy attempt opens one time. A deploy target or a re-run CI run can fail many times. The back-test needs this to tell a container from an item.
4. **A family that is not a built-in provider.** A connected MCP server, or an issuer such as Stripe, has no code entry.

## 3. Proposed contract

Define the schema with Zod in `@alfred/contracts` and derive the types with `z.infer`. The TypeScript below shows the shape only.

```ts
type PathPart = string; // a literal, "{slot}", "*" (one segment), or "**" (zero or more segments)

interface LinkPattern {
  hosts: string[]; // a host or a parent domain
  path: PathPart[]; // must match the whole path
  query?: Record<string, string>; // parameter -> "{slot}"; every listed parameter is required
}

interface SlotDecode {
  scheme: "base64url_printable_runs"; // add a scheme only with a family that needs it
  stripPrefix?: string[];
  split: string;
  fields: string[]; // names for the parts of the first printable run
}

interface UrlFamilyTemplate {
  provider: string; // a built-in provider, or a connection-scoped provider key
  kind: string; // an existing ObjectKindDef kind when the provider is built in
  lifecycle: "once" | "recurring";
  senders: string[]; // DKIM-aligned sender domains for the `about` reading
  links: LinkPattern[];
  decode?: Record<string, SlotDecode>; // slot -> decode
  identity: ObjectIdentityDecl; // attributes name slots or decoded fields
  containers: string[]; // slots that never identify the item alone
  events?: { subject: { prefix: string } | { contains: string }; state: StateCategory; opens?: boolean }[];
}
```

- The current `linkLabel` stays as a separate binding form for built-in kinds. It is not shorthand for a pattern: a label matches a path segment or a query parameter, in any position and order, and no whole-link pattern is equal to that. A template uses patterns, and its identity attributes have no `linkLabel`.
- `events[].subject` is plain text: `{ "prefix": ... }` or `{ "contains": ... }`, compared without case. A model drafts the template, so the data holds no regular expression.
- A mail links an item only through one link that fills every identity slot. Two different keys in one mail link nothing, as in `labeledTuple` today.
- Every matching pattern contributes its identity. Pattern order gives no precedence. A link with conflicting identities gives no single key, and its candidates reach the back-test ambiguity gate.
- Identity declarations and attributes reject unknown fields. A declaration has exactly one form (`uniqueKey` or `tuple`), and a tuple names distinct attributes.
- Path matching uses a suffix-state grid, with at most two distinct bindings per state. A grid above 16,384 states does not match. This bounds work for repeated `**` parts and long URLs without recursive path enumeration.
- `containers` is data for review and for the negative control (section 5). Code never makes a key from a container slot alone.
- `events` maps the issuer's subject line to a state. Without the closure decision in section 6, an event only proposes. It never closes.

## 4. Storage and ownership

- **Built-in providers:** templates are constants beside `INTEGRATION_OBJECT_DEFS` in `@alfred/contracts`. The code review is the approval.
- **Issuers and connected MCP servers:** templates are rows, with the same review shape as `mcp_health_mapping`: provider key, kind, `definition` jsonb, `revision`, `reviewed_at`, the stored back-test result, and a status (`unreviewed`, `reviewed`, `drifted`). Only `reviewed` proposes keys.
- `connections/object-state/identity-containment.ts` reads both sources through one function. The reconciliation path does not change: mail proposes a key, and the reducer-owned projection or a verified read decides the state.

## 5. Lifecycle of a template

1. **Draft.** A model receives sample mails of one sender family and writes a template. This is the only model step, and it runs one time for each family revision.
2. **Back-test.** Code runs the template over stored mail. The gates are:
   - G1: for a `once` kind, no key gets two opening events from different threads.
   - G2: no mail names two different keys of the template.
   - G3: every mail whose subject matches an event also yields a key.
   - G4: the negative control fails. The control is the same template with `identity` set to the container slots, read as `once`. A `recurring` control cannot fail G1, so the control is always `once`. If the control passes, the corpus cannot tell a container from an item for this family, and the template waits for more mail. A template without containers has no control.
   - G5: each declared same-item or different-item mail pair yields the expected keys. A missing, unkeyed, or ambiguous mail fails the pair. For a family with known pairs, the owner supplies these controls. A family with no known pairs can still pass the consistency gates; the report states this limit. A template need not join two mails in every corpus: the Railway attempt sample has one mail per key.
   - A template that keys no mail has no evidence, and it fails.
3. **Approve.** The owner sees the back-test output: keys, their mails in time order, and the control result. Then the owner approves.
4. **Watch.** A scheduled job runs the same gates over new mail. A gate failure sets `drifted`, and the template stops proposing until the owner reviews it again.

The production back-test is `apps/server/src/scripts/dry-runs/backtest-url-family-templates.ts`. It reads stored Gmail documents and calls `backtestUrlFamilyTemplate` (`connections/object-state/url-family-backtest.ts`), which applies G1-G5 and derives the container control. The template matcher and `collectProviderLinks` read links through the same `collectLinkParts` in `contracts/src/integration-objects.ts`.

The command accepts a non-empty array of templates or back-test cases. A case keeps corpus controls separate from the runtime template:

```json
{
  "template": "<the full template object>",
  "expectedPairs": [
    { "mailIds": ["doc_request", "doc_receipt"], "relation": "same" },
    { "mailIds": ["doc_request", "doc_next_invoice"], "relation": "different" }
  ]
}
```

The ids must occur in the selected user's mail corpus and yield one key each. A pair outside the selected time window fails. Without pair controls, PASS means consistency only; the owner must confirm the joins before approval.

## 6. Open decision: can an issuer mail close an item?

Stripe is not an object-state provider, so today no read can confirm that an invoice is paid. The receipt mail is the only evidence. Proposal: a new closure source, `issuer_mail`, which applies only when all of these are true:

- The template is `reviewed` and its kind is `once`.
- The mail passes DKIM, aligned to a domain in `senders`.
- The key is exact (every identity slot filled from one link).
- The event is not an opening event, and it comes after an opening event on the same key.

This amends ADR-0062 and ADR-0103 (closure needs `verified_push` or `verified_pull`) and ADR-0109 (a soft edge closes only through a verified read). Readers show `issuer_mail` separately from a provider read. The decision belongs to the owner.

**Time fields.** An `issuer_mail` close is supporting evidence, not a source check. Where the item feeds workspace memory (ADR-0111 D2b), it sets `lastSupportedAt` to the receipt's source time and leaves `lastVerifiedAt` unchanged. Only a `verified_push` delivery or a `verified_pull` read sets `lastVerifiedAt`.

## 7. Back-test result on the replay corpus

The production command gave this result on 2026-10-25, over the same 995 mails (35 days, read-only session). The draft harness gave the same counts. "Mails keyed" counts only mails from a template sender.

| Template | Lifecycle | Mails keyed | Keys | Result |
| --- | --- | --- | --- | --- |
| `stripe.hosted_invoice` | once | 5 | 3 | PASS. Both Railway request and receipt pairs join, and the September and October invoices stay apart. A Voyage AI invoice is a third key. |
| `railway.deploy_link` (attempt) | once | 12 | 12 | PASS |
| `railway.deploy_link.target` | recurring | 12 | 2 | PASS |
| `github.actions_run` | recurring | 29 | 27 | PASS. One run has three failure mails: attempts 1, 2, and 3. |
| Control: Stripe with account as identity | once | 5 | 2 | FAIL, as required |
| Control: Railway attempt with the target tuple | once | 12 | 2 | FAIL, as required |

The `github.actions_run` result checks the template against mail only. No `integration_objects` row holds a `run_id` today, so the template has nothing to join until build step 5 lands. Two quirks appeared only in real mail: a GitHub re-run keeps its `run_id`, and GitHub writes both "Run failed" and "PR run failed". A family without stable ids in its links, for example many bank alerts, gets no template. It needs a provider read or it stays unjoined.

The initial production run above used G1-G4. A review replay of the stored URL extracts showed why pair controls are needed: the decoded Stripe invoice identity gave 5 mails, 3 keys, and 2 joined pairs; the full URL token gave 5 keys and no joins, but both passed G1-G4. G5 checks those known pairs rather than treating consistency as proof of useful joins.

## 8. Build order

1. Zod contract, the shared link reader, and the production back-test command, with the gates and the control. One PR: `knip` rejects a contract that has no consumer. `IdentityAttribute` and `ObjectIdentityDecl` become `z.infer` types without a behavior change.
2. Run the back-test on the production corpus and record the result in section 7. Done 2026-10-25.
3. The template table, review route, and drift job for issuer and connection-scoped families (section 4).
4. The Stripe hosted-invoice template as the first reviewed row, with propose-only events. It is a row, not a constant: Stripe is an issuer, and `OBJECT_STATE_PROVIDERS` holds only `github`, `sentry`, `railway`, `vercel`, and `mcp` (`contracts/src/integration-objects.ts:122`).
5. The GitHub run template, after a reducer change. Mail links carry `runs/<run_id>`, but `ci_attempt` rows key on `check_suite_id` (`connections/object-state/github-reducer.ts:158`), and no reducer reads `workflow_run` deliveries. Thus no object row holds a `run_id` today, and the section 7 result is a back-test result only. Choose one before this step:
   - Record `run_id` and `run_attempt` on `ci_attempt` from `workflow_run` deliveries. The subject's "Attempt #N" then names one attempt exactly, and the kind stays `once`.
   - Add a recurring `ci_run` kind with its own `ObjectKindDef`, between `ci_attempt` and `ci_target`.

   Either way, the template becomes a built-in constant only after a kind can hold the key.
6. The `issuer_mail` closure source, only after the section 6 decision.

Follow the repository rule: add no tests. The Zod parse enforces the contract. The back-test checks consistency and the declared pairs; the owner confirms the joins. State the residual risk in each PR body: a family can change its link format without notice, and only the drift job detects it.
