---
id: closed-provider-status-map
section: Backend
status: stays-review
rung: none
---

# Map every provider status in a closed table. Make an unknown status a fault, not a default.

Why: an unknown state that reads as `absent` counts toward a demotion. Example: `VERDICT_BY_VERCEL_STATE`, #1364.

## Bad

```ts
switch (state) {
  case "READY": return "success";
  case "ERROR": return "failure";
  case "BUILDING": case "INITIALIZING": case "QUEUED": return "pending";
  default: return null;
}
```

## Good

```ts
const VERDICT_BY_VERCEL_STATE = {
  READY: "success",
  ERROR: "failure",
  BUILDING: "pending",
  INITIALIZING: "pending",
  QUEUED: "pending",
  CANCELED: null,
  DELETED: null,
} satisfies Record<(typeof VERCEL_DEPLOYMENT_STATES)[number], VerifiedPullStatus | null>;
```

A state outside the table parses to `"unknown"`, and a miss on it is a fault.

## Mechanism

The compiler holds a map after someone writes it. To decide that one is necessary is design.

## Hits

- #1364 packages/assistant/src/connections/verified-pull/vercel.ts: a `switch` default sent an unknown state to `null`, which read as `absent`.
