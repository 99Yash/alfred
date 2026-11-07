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
- #1665 official-warnings/sachet.ts readCap: null meant no match, link outside Sachet, and unreadable shape; the null was cached and never counted as unread
- #1665 agent/tools.ts list_official_warnings: null (no feed read), undefined (old run) and an empty read all gave the model []
- #1672 knowledge/activity.ts skipped an unparsable payload with only a warn while coverage still said live; briefings/provenance.ts connectSlug returned null for two different states
- #1690 verifyLoops kept five states in one readFailed boolean: a read fault, the cap, no reader, no plan, and a commit fault. Now a union of six reasons.
