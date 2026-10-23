# ADR-0112 — Chat follow-up prompts: one cheap call after each completed reply (BUILT — 2026-10-23)

**Problem.** After a reply, the chat offers next prompts: one prompt shows as ghost text in the empty composer, and two or more show as chips with `⌥1`…`⌥9`. Before this ADR, a rule table in the web made the prompts. It read the reply's tool results and gave fixed text for 4 tool kinds (`github.search`, `calendar.list_events`, `gmail.search`, `system.web_search`), for example "Go deeper on this." A reply with no such tool got no prompt, and the text never matched the conversation.

**Decision.** The server writes the prompts with one cheap model call after each completed reply. The web shows them through the existing ghost and chip UI.

## D1 — The call runs in `armTurnFollowups`, after the reply is final

`maybeGenerateFollowUps` (`packages/assistant/src/chat/chat-follow-ups.ts`) is a fourth fire-and-forget entry in `armTurnFollowups` (`chat-turn-closure.ts`), beside memory capture, compaction, and `maybeGenerateThreadTitle`.

- `armTurnFollowups` runs only for a completed, not-cancelled turn. A failed or stopped reply gets no call.
- It runs after `publishCompletedFrame`. The client already has the final reply before the call starts, so a slow or failed call cannot block or fail the reply.
- The function never throws. A failure logs `chat_follow_ups_failed` and writes nothing.

## D2 — The model is `route("cheap")`

The call uses `route("cheap")` from `@alfred/ai` (gemini-2.5-flash-lite, fallback gemini-3.8-flash, no reasoning) through `meteredGenerateObject`, with a 10 s timeout and the metering name `chat.follow-ups`. The prompt holds the latest user message (up to 2,000 characters) and the reply (up to 4,000 characters). The model returns 0 to 3 short prompts in the user's voice, or none when the reply closes the topic.

Measured on 3 real local replies (2026-10-23): 248 to 315 input tokens, 42 or 43 output tokens, $0.000042 to $0.000048, and 1.3 s to 3.8 s for each call. The input caps bound the worst case at about 1,800 input and 200 output tokens, which is about $0.0003 at list price ($0.10 / M input, $0.40 / M output). The fallback leg costs more for each token, and it runs only when the first leg fails. The message `usage` strip does not include this call, because `aggregateRunUsage` runs before it.

## D3 — The prompts persist on the reply row

The prompts go into a new nullable column `chat_messages.follow_ups text[]`. The write is guarded on the row id, the user, the `runId` that made the call, and `status = 'complete'`, and it bumps `row_version` and pokes Replicache. The web reads them through the existing `chatmsg` model. There is no new SSE frame, route, or table, and the prompts survive a reload.

`chatFollowUpsSchema` in `@alfred/contracts` holds the caps: 1 to 3 strings, each 1 to 120 characters. The server parses with it before the write. `syncedChatMessageSchema` parses with it again and reads a bad or older value as `null`. Before the parse, the server removes em and en dashes (`sanitizeVoice`), list marks, quotes, and duplicates.

## D4 — The rule-based chips are deleted

`followUpForTool` and the chip brand glyph are deleted. A reply without model prompts shows no prompt. There is no fallback to the fixed text, because two sources for one row would return the problem this ADR removes.

## Considered and rejected

- **Generate in the HTTP request or in the web.** The web cannot import `@alfred/ai`, and the request only enqueues the run.
- **Generate inside the boss run (a tool or a structured tail on the reply).** The reply would wait for the prompts, the call would use the expensive model, and the chat system prompt would change. `assertStableChatSystem` pins the prompt hash, so a run parked across the deploy would fail.
- **A new SSE frame.** The `completed` frame already ended the stream. The row and a Replicache poke are the existing path.
- **A BullMQ job for each turn.** A retry queue for a cosmetic prompt costs more than it gives. The title uses fire-and-forget too.
- **A separate table or a `jsonb` column.** One list of strings for each reply, read only with the reply, fits a `text[]` column.
- **Ask the model for a brand to keep the glyph.** It adds a closed enum to the model output only for decoration.
