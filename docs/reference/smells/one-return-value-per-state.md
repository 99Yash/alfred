---
id: one-return-value-per-state
section: Backend
status: stays-review
rung: none
---

# Give each state its own return value.

A miss and a fault are two variants.

Why: a miss counter that also counts faults demotes healthy rows in an outage. Example: `VerifiedPullRead`, #1356.

## Bad

```ts
/** `null`: a fault, or a list that held no deployment of the target. */
readStatus(session: Session, target: Target): Promise<VerifiedPullReading | null>;
```

## Good

```ts
/** `absent`: every read succeeded and none held the target. `null`: a fault. */
export type VerifiedPullRead = VerifiedPullReading | "absent" | null;

readStatus(session: Session, target: Target): Promise<VerifiedPullRead>;
```

## Mechanism

The compiler holds a map after someone writes it. To decide that one is necessary is design.

## Hits

- #1356 packages/assistant/src/connections/verified-pull/driver.ts: one `null` meant both a miss and a fault; `"absent"` is now its own variant, and only it counts toward demotion.
