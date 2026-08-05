/**
 * Chat → memory capture (chat-memory-capture-v1.md, #397).
 *
 * What remains here is the cheap-model EXTRACTOR (`./extractor`) that distills a
 * finished thread into crisp, tagged propositions — Phase 4 knowledge work. The
 * idle-debounce end-of-thread TRIGGER moved to
 * `conversations/idle-capture-queue.ts`, next to the compaction it drives. No
 * durable writes happen here — the observation write path lands in #399.
 */

export * from "./extractor";
