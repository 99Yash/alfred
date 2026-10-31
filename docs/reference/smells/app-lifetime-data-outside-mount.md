---
id: app-lifetime-data-outside-mount
section: Frontend
status: stays-review
rung: none
---

# Do not keep data that must outlive one page view in a ref or a state that each mount creates.

A reset that runs on each route change has the same fault. Keep the data in a store that the app shell owns.

Why: the shared event bus does not send old frames again, so a page that mounts again starts empty. Example: #1486 moved the live chat state to a module store in `apps/web/src/lib/chat/use-chat-stream.ts`, and #1489 fixed the same fault for artifacts. #1487 removed the rail clear from the route-change block of `AppShell`.

## Bad

```ts
export function useChatStream(threadId: string | undefined): ChatStream {
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);

  useEffect(() => {
    const cell = createChatStreamCell(threadId); // per mount: frames from before are lost
```

## Good

```ts
const threads = new Map<string, ThreadStream>(); // module store; it outlives the page

export function useChatStream(threadId: string | undefined): ChatStream {
  const stream = useSyncExternalStore(subscribe, getSnapshot, () => null);
```

## Mechanism

The lifetime of the data is a product fact, not a fact in the code.

## Hits

- #1486 `apps/web/src/lib/chat/use-chat-stream.ts`: the live turn lived in per-mount state, so a return to the thread showed no live turn.
- #1489 `apps/web/src/lib/chat/use-artifact-stream.ts`: the live artifact body had the same per-mount fault.
- #1487 `apps/web/src/lib/shell/app-shell.tsx`: the route-change block of `AppShell` cleared the rail and the thread view model.
