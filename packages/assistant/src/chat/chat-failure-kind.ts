import { isQuotaOrBillingError } from "@alfred/ai";
import { HttpError, toMessage, type ChatErrorKind } from "@alfred/contracts";
import { threadImageAttachments } from "./chat-attachments";
import type { ChatRunState } from "./chat-turn-state";
import { isStreamTimeoutAbort } from "./stream-timeout";

/**
 * Tag a terminal chat fault for the failed row. Looks up the thread's images
 * first: only a thread with an image may report an image rejection (ADR-0072).
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
 * Map a fault to a {@link ChatErrorKind}. Providers give no typed errors, so the
 * message is sniffed as a last resort. Order matters: an image rejection often also carries a 4xx.
 */
export function classifyChatFailure(
  err: unknown,
  opts: { currentTurnHasImage: boolean; historicalHasImage: boolean },
): ChatErrorKind {
  const msg = toMessage(err).toLowerCase();

  // The only real attachment failure is the provider rejecting an image (ADR-0072).
  // "unsupported file" and "decode" also match tool errors, so they need an image word too.
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
    // Prefer the current turn: "Send without it" can drop that image, not an older one.
    if (opts.currentTurnHasImage) return "attachment";

    if (opts.historicalHasImage) return "attachment_history";
  }

  if (
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("prompt is too long")
  ) {
    return "too_long";
  }

  // Money does not refill on a backoff, so this precedes the 429 nets. Read the
  // provider's own signal: a second phrase list here would drift from it.
  if (isQuotaOrBillingError(err)) return "budget_exhausted";

  // `\b` so an id or token count that contains "429" does not match.
  if (err instanceof HttpError && err.status === 429) return "rate_limited";

  if (msg.includes("rate limit") || msg.includes("too many requests") || /\b429\b/.test(msg)) {
    return "rate_limited";
  }

  // Our own stream timeout: the model ran long. Check before the `overloaded` net,
  // whose bare "timeout" would catch it. Keep these narrow: "gateway timeout" is `overloaded`.
  if (
    isStreamTimeoutAbort(err) ||
    msg.includes("aborted due to timeout") ||
    msg.includes("operation timed out") ||
    msg.includes("timeout of ")
  ) {
    return "timeout";
  }

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
