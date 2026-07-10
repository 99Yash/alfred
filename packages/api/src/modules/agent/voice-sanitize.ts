/**
 * Deterministic enforcement of the one voice rule a model won't reliably follow
 * from an instruction: no em-dashes. Sonnet/Opus reach for `—` on nearly every
 * reply regardless of DEFAULT_VOICE_PROMPT, and it is a purely mechanical
 * substitution, so we fix it in code rather than hoping the model complies. This
 * matches the user's standing "no em/en dashes in copy" preference.
 *
 * Scope is deliberately narrow: only the Unicode em-dash (—) and en-dash (–)
 * that models actually emit. ASCII `--` is left alone (it is a CLI flag far more
 * often than a dash in real prose), emoji are left to the prompt (chat may mirror
 * a user's emoji), and code spans + numeric ranges are preserved.
 *
 * `sanitizeVoice` is for batch text (a whole briefing body, a finished summary).
 * `createVoiceStreamSanitizer` is for the chat token stream, where a dash can
 * straddle two deltas — it holds back an ambiguous trailing run until the next
 * chunk resolves it.
 */

// code span (passed through) | numeric range | prose dash. Only spaces/tabs are
// eaten around a prose dash so line breaks (and markdown list structure) survive.
const CODE_OR_DASH = /(```[\s\S]*?```|`[^`]*`)|(\d)[ \t]*[—–][ \t]*(?=\d)|[ \t]*[—–][ \t]*/g;

/** Replace em/en dashes with plain punctuation, leaving code and ranges intact. */
export function sanitizeVoice(text: string): string {
  if (!text.includes("—") && !text.includes("–")) return text;
  const out = text.replace(CODE_OR_DASH, (_m, code: string | undefined, rangeDigit: string | undefined) => {
    if (code !== undefined) return code; // leave code untouched
    if (rangeDigit !== undefined) return `${rangeDigit}-`; // numeric range: 10–20 -> 10-20
    return ", "; // prose dash -> comma
  });
  // Collapse any doubled comma an adjacent-dash run produced ("— —" -> ", ,").
  return out.replace(/,[ \t]*,/g, ",");
}

export interface VoiceStreamSanitizer {
  /** Feed a raw text delta; returns the sanitized text that is safe to emit now. */
  push(raw: string): string;
  /** End of a segment/stream: returns the sanitized held-back tail and resets. */
  flush(): string;
}

// A trailing run we can't safely emit yet: optional spaces/tabs, an optional
// single dash, optional spaces/tabs, at end of buffer. Holding it lets the next
// chunk supply the dash's right-hand side so "word —" + " next" collapses to
// "word, next" rather than emitting a stranded dash.
const AMBIGUOUS_TAIL = /[ \t]*[—–]?[ \t]*$/;

export function createVoiceStreamSanitizer(): VoiceStreamSanitizer {
  let pending = "";
  return {
    push(raw: string): string {
      pending += raw;
      const m = AMBIGUOUS_TAIL.exec(pending);
      const holdStart = m ? m.index : pending.length;
      const safe = pending.slice(0, holdStart);
      pending = pending.slice(holdStart);
      return sanitizeVoice(safe);
    },
    flush(): string {
      const rest = pending;
      pending = "";
      // A reply that literally ends on a dash sanitizes to a trailing ", " —
      // trim that artifact so we don't end the message on a dangling comma.
      return sanitizeVoice(rest).replace(/,[ \t]*$/, "");
    },
  };
}
