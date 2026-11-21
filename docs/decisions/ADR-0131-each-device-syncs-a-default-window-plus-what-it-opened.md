# ADR-0131 — Each device syncs a default window plus what it opened (partial sync in Replicache)

**Status.** Accepted; not built. Owner decision, 2026-11-21. The owner approved partial sync, a default of 20 chat threads, a short load for an item outside the default, and one sync extent for all the tabs of a device. The owner then approved the agent's defaults in decisions 2 and 4: one extent for each device, pinned threads in the default window, and opened lists of 20 threads and 10 briefing dates.

Keeps: [ADR-0061](./ADR-0061-replicache-stays.md) (Replicache stays). Amends: [ADR-0049](./ADR-0049-in-app-briefing-surface-paragraph-first-day.md) and [ADR-0041](./ADR-0041-daily-briefing-v2-cross-source-llm-compose.md) (the 30-day briefing window), [ADR-0065](./ADR-0065-chat-file-uploads-degrade-every-non-universal.md) (the attachment key), [ADR-0075](./ADR-0075-produce-artifact-capability-the-agent-generates.md) (the artifact window).

## Why

- **An old chat thread opens empty.** The pull sends the newest 500 messages of the user, from all threads together (`packages/http/src/sync/read/chat.ts`, `recentMessages`). The thread list has no limit. When the user has more than 500 messages, the oldest threads show in the sidebar, but they open with no messages. Nothing loads them, and nothing tells the user.
- **One thread is cut in half.** The 500th message is usually in the middle of a thread. That thread opens without its first messages. The artifact window (the newest 200, from all threads) has the same two faults.
- **An old briefing link opens empty.** Each briefing mail links to `/briefings/<date>` (`briefings/workflow-operations.ts`). The pull sends only 30 days. `CONTEXT.md` names an on-demand `/api/briefings/history` route for older days, but that route does not exist.
- **Each change re-reads all synced messages.** The open thread subscribes to the full `chatmsg/` prefix and filters on the client (`apps/web/src/lib/replicache/use-chat.ts`). The attachment hook does the same again. Each message write runs both. Measured on the local corpus (344 messages, 951 KB): 0.60 ms to parse and filter, against 0.04 ms for one thread, plus a compare of the full result. The cost is small today. It grows with each message up to the cap.

The Replicache row-version strategy supports this directly. The client view can be any query, and it can be different for each device. Replicache's guide ("Queries and Windowing") puts the query in a synced row, so that all tabs read the same query and do not fight. ADR-0061 trigger (b) does not fire: partial sync is cheap in the model that Alfred already has.

## Decisions

1. **The sync extent.** For each entity that has a window, the client view is the **default window** plus the items that this device **opened**. The two are joined: a device gets both.
2. **One extent for each device, not for each user.** The extent belongs to the Replicache client group (one browser profile). A thread opened on the phone does not sync to the laptop.
3. **All tabs add to one extent. No tab removes an item.** Each open adds the item, with its open time. When a list is full, the item with the oldest open time goes out. Thus tab A and tab B both get their items, with no per-tab state and no tab lifetime to track. Opening an item in the default window also records it, so it does not drop out when newer threads push it past the default.
4. **The limits.**
   - Chat: the default window is the 20 threads with the newest `lastMessageAt`, plus the pinned threads. The opened list holds 20 threads.
   - A thread in the extent syncs whole: all its messages, attachments, and artifacts. This replaces the 500-message, 500 × attachment, and 200-artifact windows. A thread is never cut.
   - Briefings: the default window stays 30 days. The opened list holds 10 dates. The history route in `CONTEXT.md` is removed from the text. It was never built.
5. **The extent is a synced row, and only the server writes it.** The row lists the opened items of the device. The client mutator (for example `syncExtentOpen({ kind, id })`) does not change the local row. The server writes the row in the push. The next pull sends the row and the item's data in one patch. Thus, when an item shows in the row, its data is on the device, and an empty result is real. Until then, the surface shows its loading state. The loading rule in `use-replicache-subscription.ts` ("empty reads as loading until the first pull") gets this second case.
6. **Chat keys include the thread.** `chatmsg/<threadId>/<id>` and `chatatt/<threadId>/<messageId>/<id>`. The attachment pull adds `threadId` from its message. The open thread scans one prefix (`scanPrefix`), and a thread delete removes one prefix. Artifact keys stay `artifact/<id>`, because `threadId` can be null. Only the artifact window changes. *(Agent decision on the mechanism.)*
7. **No schema-version bump.** On the first pull after the deploy, the CVR diff deletes each old key (`chatmsg/<id>`) and puts the new key, in one patch (`pull.ts`). An expired CVR (12 h) is a cold sync, as before.
8. **No change to the other entities now.** Todos (2 days after done), triage tags (30 days), facts, notes, preferences, policies and workflows have no screen that reads past their window. Skill runs have no window. That is a growth risk, not a fault today. A skill page can join the extent when it needs to.

## Residual risk

- A very long thread syncs whole. With one user this is acceptable. A cap for each thread is a later decision.
- An open sends one push. A thread that the user opens often already has a recent entry, so the client skips that push.
- An item can drop out of the opened list while one tab still shows it, if the user opens 20 other items on the same device first. The tab then shows its loading state and adds the item again.

## Alternatives

- **(a) Remove the windows and sync all history.** Rejected. Storage, cold sync, and each subscription grow with all history, with no limit.
- **(b) An HTTP read for items outside the window.** Rejected. That is a second read path with its own cache, loading and live update. The extent reuses the pull, the CVR and the pokes.
- **(c) One extent for each tab, joined at pull time.** Rejected. A Replicache client has no close signal, so the server must expire the extent of each dead tab. The shared list with a limit gives the same join with no lifetime.
- **(d) Re-key the chat only, and keep the 500-message window.** Rejected as the whole change. It makes the scans smaller, but old threads still open empty and one thread is still cut.
- **(e) Move to Zero (ADR-0061 trigger b).** Rejected. The row-version model in Alfred supports partial sync.

## Cross-ref

Replicache docs: "Row Version Strategy" and its section "Queries and Windowing"; the `todo-row-versioning` example (the extent in a synced row). Index: `chat_messages_thread_created_idx` serves the read for each thread.
