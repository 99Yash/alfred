# ADR-0112 — Chat follow-up prompts: one cheap call after each completed reply (BUILT — 2026-10-23)

**Problem.** After a reply, the chat offers next prompts. One prompt shows as ghost text in the empty composer. Two or more prompts show as chips with `⌥1`…`⌥9` shortcuts. Before this ADR, a rule table in the web made the prompts. It read the reply's tool results and gave fixed text for 4 tool kinds. One example is "Go deeper on this." A reply with no such tool got no prompt. The fixed text never matched the conversation.

**Decision.** The server writes the prompts with one cheap model call after each completed reply. The web shows them through the existing ghost and chip UI.

## D1 — The call runs in `armTurnFollowups`, after the reply is final

`maybeGenerateFollowUps` (`packages/assistant/src/chat/chat-follow-ups.ts`) is a fourth fire-and-forget entry in `armTurnFollowups` (`chat-turn-closure.ts`), beside memory capture, compaction, and `maybeGenerateThreadTitle`.

- `armTurnFollowups` runs only for a completed, not-cancelled turn. A failed or stopped reply gets no call.
- It runs after `publishCompletedFrame`. The client already has the final reply before the call starts, so a slow or failed call cannot block or fail the reply.
- The function never throws. A failure logs `chat_follow_ups_failed` and writes nothing.

## D2 — The model is `route("cheap")`

The call uses `route("cheap")` from `@alfred/ai` (gemini-2.5-flash-lite, fallback gemini-3.8-flash, no reasoning) through `meteredGenerateObject`, with a 10 s timeout and the metering name `chat.follow-ups`. The prompt holds the latest user message (up to 2,000 characters) and the reply (up to 4,000 characters). The model returns 0 to 3 short prompts in the user's voice, or none when the reply closes the topic.

Measured on 3 real local replies (2026-10-23). Each call took 248 to 315 input tokens and 42 or 43 output tokens. That is $0.000042 to $0.000048 per call. Each call took 1.3 s to 4.0 s. The input caps bound the worst case at about 1,800 input tokens and 200 output tokens. At list price ($0.10 / M input, $0.40 / M output), that is about $0.0003. The fallback leg costs more for each token. It runs only when the first leg fails. The message `usage` strip does not include this call, because `aggregateRunUsage` runs before it.

## D3 — The prompts persist on the reply row

The prompts go into a new nullable column `chat_messages.follow_ups text[]`. The write is guarded on the row id, the user, the `runId` that made the call, and `status = 'complete'`. It bumps `row_version` and pokes Replicache. The web reads them through the existing `chatmsg` model. There is no new SSE frame, route, or table, and the prompts survive a reload.

`chatFollowUpSchema` in `@alfred/contracts` holds the per-prompt rule: trimmed text, 1 to 120 characters, and no em or en dash. `chatFollowUpsSchema` builds a list of 1 to 3 prompts from it. The server keeps each entry that passes the per-prompt schema, drops the rest one at a time, removes duplicates, and caps the list at 3. `syncedChatMessageSchema` parses with the list schema again and reads a bad or older value as `null`. Before the parse, the server strips list marks and quotes, repairs dashes with `sanitizeVoice`, and collapses whitespace.

## D4 — The rule-based chips are deleted

`followUpForTool` and the chip brand glyph are deleted. A reply without model prompts shows no prompt. There is no fallback to the fixed text, because two sources for one row would return the problem this ADR removes.

## Residual risk

The chips are model-written, and the reply they extend can quote third-party mail or web text. One click or `⌥N` sends a chip as the user's own message, with no further check. With policy mode Auto, a mutating tool can then run with no approval gate. The user still sees the chip text before the send, so the check is the user's own read.

## Considered and rejected

- **Generate in the HTTP request or in the web.** The web cannot import `@alfred/ai`, and the request only enqueues the run.
- **Generate inside the boss run (a tool or a structured tail on the reply).** The reply would wait for the prompts, the call would use the expensive model, and the chat system prompt would change. `assertStableChatSystem` pins the prompt hash, so a run parked across the deploy would fail.
- **A new SSE frame.** The `completed` frame already ended the stream. The row and a Replicache poke are the existing path.
- **A BullMQ job for each turn.** A retry queue for a cosmetic prompt costs more than it gives. The title uses fire-and-forget too.
- **A separate table or a `jsonb` column.** One list of strings for each reply, read only with the reply, fits a `text[]` column.
- **Ask the model for a brand to keep the glyph.** It adds a closed enum to the model output only for decoration.
