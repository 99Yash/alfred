import { HttpError, toMessage, type ChatErrorKind } from "@alfred/contracts";
import { threadImageAttachments } from "./chat-attachments";
import type { ChatRunState } from "./chat-turn-state";
import { isStreamTimeoutAbort } from "./stream-timeout";

/**
 * What a terminal chat fault is *called* for the user.
 *
 * Separate from the closure protocol that persists the turn: the two do not
 * co-vary. Adding a {@link ChatErrorKind} is a change to this file, the contract,
 * and the web client's copy for it, and touches nothing about how a turn is
 * written or which ending it gets; adding a turn ending is the reverse. The
 * closure calls {@link classifyChatTurnFailure} and never sees the branches.
 */

/**
 * Tag a terminal chat-turn fault for the row the closure is about to write.
 *
 * The async wrapper is the whole public door: the ADR-0072 presence gate needs
 * to know whether this thread actually carries an image before it may say an
 * image was rejected, and reading that is a query. A caller holding only
 * {@link classifyChatFailure} would have to remember to run it and would get a
 * plausible, wrong `generic` for free by passing two `false`s.
 */
export async function classifyChatTurnFailure(
  userId: string,
  state: Pick<ChatRunState, "threadId" | "userMessageId">,
  err: unknown,
): Promise<ChatErrorKind> {
  const images = await threadImageAttachments(userId, state.threadId, state.userMessageId);
  return classifyChatFailure(err, {
    currentTurnHasImage: images.currentTurn,
    historicalHasImage: images.historical,
  });
}

/**
 * Map a terminal chat-turn fault to a user-meaningful {@link ChatErrorKind}.
 * Branches on structured signals first ({@link HttpError.status}, our own
 * sentinel throws), then falls back to sniffing the message — providers don't
 * give us typed errors, so the string is the last resort. Order matters:
 * attachment rejections often *also* carry a 4xx, so check them before status.
 * Anything unrecognized is `generic` (the client shows a neutral retry). The
 * raw text never reaches the user — only this tag does.
 *
 * Pure, and exported for the table-driven tests over the signal set; production
 * reaches it through {@link classifyChatTurnFailure}, which sources `opts`
 * rather than letting a caller assert it.
 */
export function classifyChatFailure(
  err: unknown,
  opts: { currentTurnHasImage: boolean; historicalHasImage: boolean },
): ChatErrorKind {
  const msg = toMessage(err).toLowerCase();

  // ADR-0072: the only genuine attachment failure is the model provider
  // rejecting a hydrated image at the generation call (recurs on transcript
  // replay — see .lessons/chat-vision-transcript-replay-poison.md). The narrow
  // signal set replaces the old over-broad substring net (attachment|file|
  // image|media|mime) that mis-bucketed unrelated tool/export failures.
  //
  // "unsupported file" / "unsupported media" / "decode" / "corrupt" are NOT
  // image-specific on their own — a `drive.export_file: unsupported file export
  // type` (or any tool error) trips them in an image-bearing thread. Gate them
  // behind an explicit image/picture/photo mention so only a message that
  // actually names an image counts; everything else falls through to generic.
  const mentionsImage = msg.includes("image") || msg.includes("picture") || msg.includes("photo");
  const isImageReject =
    msg.includes("unable to process input image") ||
    msg.includes("invalid image") ||
    msg.includes("unsupported image") ||
    (mentionsImage &&
      (msg.includes("unsupported file") ||
        msg.includes("unsupported media") ||
        msg.includes("decode") ||
        msg.includes("corrupt")));
  if (isImageReject) {
    // Prefer the recoverable kind: if the current turn has an image, "Send
    // without it" can drop it. Otherwise, if only an earlier turn's replayed
    // image can be the culprit, say so honestly — the retry can't reach it.
    if (opts.currentTurnHasImage) return "attachment";
    if (opts.historicalHasImage) return "attachment_history";
    // No image anywhere → not an attachment failure; fall through to generic.
  }

  // Our own turn-cap sentinel (see `CHAT_TURN_CAP_MAX`) — the turn can't continue.
  if (msg.includes("chat_turn_limit_exceeded")) return "too_long";
  // Context / token ceilings reported by the provider.
  if (
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("prompt is too long")
  ) {
    return "too_long";
  }

  // Upstream throttling. Prefer the typed status; the substring match is a
  // fallback for stringified errors — `\b` so a request id / token count that
  // merely contains "429" doesn't get mis-tagged.
  if (err instanceof HttpError && err.status === 429) return "rate_limited";
  if (msg.includes("rate limit") || msg.includes("too many requests") || /\b429\b/.test(msg)) {
    return "rate_limited";
  }

  // Our own streaming circuit-breaker aborted the turn (it ran past the total
  // or chunk stream ceiling): the model ran long, not a provider fault, so tag
  // it `timeout` — the client can say "that took too long" and offer a plain
  // retry, distinct from the `overloaded` glitch copy. Checked *before* the
  // transient-fault net below, whose bare `timeout`/`timed out` substrings
  // would otherwise swallow it. The structural check catches the raw
  // `TimeoutError` DOMException; the message patterns are the stringified
  // fallback and stay narrow so a provider "gateway timeout" still reads as a
  // transient fault below.
  if (
    isStreamTimeoutAbort(err) ||
    msg.includes("aborted due to timeout") ||
    msg.includes("operation timed out") ||
    msg.includes("timeout of ")
  ) {
    return "timeout";
  }

  // Transient provider faults — 5xx, "internal error", overloaded, network.
  if (err instanceof HttpError && err.status >= 500) return "overloaded";
  if (
    msg.includes("internal error") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    /\b50[23]\b/.test(msg)
  ) {
    return "overloaded";
  }

  return "generic";
}
