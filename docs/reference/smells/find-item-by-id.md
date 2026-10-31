---
id: find-item-by-id
section: Frontend
status: stays-review
rung: none
---

# Do not find an item by its position (`.at(-1)`, index 0, the queue head) when items run in parallel or change order.

Find it by its id or by its status.

Why: another item can take that position while the work runs. Example: in #1453 a send completion removed the queue head, but a promote had put a different entry there. #1503 changed `describeActivity` in `apps/web/src/routes/-chat/conversation-helpers.ts` to find the last tool with the status `started`.

## Bad

```ts
const lastTool = visibleTools(stream.tools).at(-1);

if (lastTool && lastTool.status === "started") return `${presentTool(lastTool).running}…`;
```

## Good

```ts
// Parallel calls can settle out of order, so take the latest one still running, not the last one.
const runningTool = visibleTools(stream.tools).findLast((tool) => tool.status === "started");

if (runningTool) return `${presentTool(runningTool).running}…`;
```

## Mechanism

`.at(-1)` and index 0 are correct on a list that keeps its order. A check cannot tell that list from a list that changes order.

## Hits

- #1453 `apps/web/src/routes/-chat/chat-shell.tsx`: the send completion called `dequeue()` and removed the entry at the head, not the entry that it sent.
- #1503 `apps/web/src/routes/-chat/conversation-helpers.ts`: `describeActivity` read the last tool, and a parallel call could settle out of order.
