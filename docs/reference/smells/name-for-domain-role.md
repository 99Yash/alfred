---
id: name-for-domain-role
section: Types
status: stays-review
rung: none
---

# Name a symbol for its domain role, not its structure.

Do not use `shape` for a payload or a credential. `DayShape` is a real domain term and stays.

Why: a structural name does not tell which structure. Example: #1149.

## Bad

```ts
credential: {
  shape: "google_oauth",
  features: ["briefing", "triage", "reply_draft"],
},
```

## Good

```ts
credential: {
  credentialKind: "google_oauth",
  features: ["briefing", "triage", "reply_draft"],
},
```

## Mechanism

A substring ban cannot tell a credential `shape` field from `DayShape` (#1149).

## Hits

- #1149 `packages/contracts/src/integrations/registry.ts`: the credential field is named `shape`; its role is the credential kind.
- #1665 official-warnings/gdacs.ts: AreaFeature held properties, near held every event, centroidOf read a reported point, p named the properties
- #1672 knowledge/activity.ts used subject for the actor in one place and for the object in another, and the actor kind was other in the reader but others in list_activity
