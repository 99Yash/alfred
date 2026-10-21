# The context graph in plain words

This page is a short glossary. It gives one plain word for each idea in the context graph, and it shows which Alfred table holds that idea today. Use these words in ADRs and in chat. When an ADR needs a more exact term, it defines the term and points to the plain word here.

`CONTEXT.md` stays the full glossary. This page covers only the context graph.

Last verified: 2026-10-21 at `fd13e6427`.

---

## The words

**Event.** A record that something happened at one time. Alfred never changes an event after it writes it. Examples: a mail arrived, a PR merged, the user dismissed a todo. Table: `observations`.

**Thing.** Something in the world that events are about. Examples: a person, a company, a repository, a PR, an alarm, a deploy, a ClickUp task.

**Identity.** A key that names one thing, for example an email address, a PR URL, or an alarm ARN. Two records with the same identity are the same thing. Table: `entity_identities`.

**State.** The current condition of a thing, for example `open`, `merged`, or `failed`. Only a provider fact can set a state. Table: `integration_objects`.

**Link.** A relation between two things, for example "this PR belongs to this repository" or "this person owns this task". Table: `entity_edges`.

**Work item.** Something that the user must do or wants to watch. It has a status, and it points to the things that it is about. Today the only work item is a todo. Table: `todos`.

**Referent.** A thing that a notification is about and that no connected provider tracks, for example the Baserow alarm from SNS ([ADR-0092](../decisions/ADR-0092-notification-referent-dedup-on-the-observation-log.md)). A referent is a thing. It is not a new idea. When a provider tracks the thing, for example a PR with GitHub connected, the `integration_objects` row is the thing, and no referent is made.

**Projection.** A table that code rebuilds from events. You can delete a projection and build it again from the events. `entity_nodes`, `entity_identities`, `entity_profiles`, and `entity_edges` are projections. `observations` is not a projection.

## Glean's words and Alfred's words

Source: [How do you build a context graph](https://www.glean.com/blog/how-do-you-build-a-context-graph) (Glean).

| Glean's word | Plain word | Alfred today |
| --- | --- | --- |
| Trace | Event | `observations` |
| Entity, knowledge graph | Thing, identity, link | Three separate stores (see below) |
| Personal graph, semantic task | Work item | `todos` only |
| Edge with a probability | Link with a confidence | ADR-0109 does not let a probability close a loop |
| Context graph (patterns across many employees), playbook | Organization layer, template | See "The organization layer" below |

Alfred needs two of Glean's layers. The first is the personal graph: the user's own work, linked to the things that the work is about. The second is the organization around the user: the colleagues, their teams, and their roles.

## The organization layer

Alfred has one user, but that user works in an organization with other employees. Alfred sees the organization only through the user's data: mail, meetings, calendar, GitHub, and Linear. It cannot see a colleague's own mail or personal graph.

**Organization.** The company that the user works at. Node kind `organization`.

**Team.** A group of people in the organization, for example engineering. Node kind `group`.

**Person.** A colleague, a customer, or any other human. Node kind `person`. A person can have a **role**, for example "engineering lead".

The links between them already exist as edge types (`ENTITY_EDGE_TYPES`, `packages/contracts/src/user-model.ts:816`): `works_at`, `in_org`, `member_of`, `reports_to`, and `frequent_collaborator`. No production code writes them yet.

**What Alfred does with a colleague's work.** Alfred knows who the colleague is, their team and role, and which things they work on. The briefing can use this as team context. Alfred tracks a colleague's work as a work item only when the user asks for it in a standing instruction. Alfred always tracks the user's own work.

**What does not apply from Glean.** Glean shows a pattern only when at least *k* employees and *n* traces show it. Alfred cannot see other employees' traces, so it cannot use that rule. A back-test on the user's past data, plus the user's approval, takes its place ([ADR-0109](../decisions/ADR-0109-a-soft-edge-closes-a-loop-only-through-a-verified-read.md)).

## Who owns which thing

Decided by the owner on 2026-10-21.

| The thing | Its one record |
| --- | --- |
| A thing with provider state or a lifecycle: a PR, a deploy, a ticket | `integration_objects` (other keys for it go in `integration_object_keys`) |
| A person, an organization, a team, a service, a repository | `entity_nodes` |
| A thing that a notification is about, and that no connected provider tracks: an SNS alarm with no ARN, a newsletter issue | `entity_nodes` with kind `referent` |
| A piece of the user's work | `todos`, which link to the things above |

A referent never copies an `integration_objects` row. When a provider row exists, the row is the thing. The old `entities` table gets no new readers or writers.

## Where Alfred is confused today

These facts are verified at the commit above.

1. **Three stores hold things.** `entities` (old memory; only `knowledge/user-context.ts` reads it), `entity_nodes` (the user model), and `integration_objects` (the state of PRs, deploys, and tasks). One PR can be a referent in `entity_nodes` and also a row in `integration_objects`, and no link joins the two rows. ADR-0092 does not mention `integration_objects`.
2. **The one link table from a work object to a thing points at the old store.** `integration_object_relations.entity_id` references `entities`, not `entity_nodes`, and no code writes the table.
3. **No store holds the user's work except `todos`.** A meeting-notes action item, a commitment in chat, and a PR that the user is writing have no shared record.
4. **The user-model projection is not active in production.** So `entity_nodes` is empty in production, and only triage reads it.

## Is a graph database necessary?

No. Alfred's questions are one or two steps long: "what is open on this PR", "what did the user say about this alarm", "which of my todos does this notes mail change". A SQL join answers each of them. Glean also does not store raw text in a graph. It stores text that is tagged with entity IDs, because "pure graph structures are rigid". ADR-0058 makes the same decision: keep a graph model on Postgres, with no graph engine. The gap is in the data and in the links, not in the database engine.
