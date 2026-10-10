/**
 * The one dedupe rule for `chat.delta` and `chat.reasoning` frames. The web bubble and the
 * server's failed-closure fold both apply it, so they cannot drift.
 *
 * `attempt` grows on every step commit and on every stale-lease reclaim. A reclaimed attempt
 * restarts at the committed `seq`, so a higher attempt cuts what the older attempt sent from
 * that `seq` on. A lower attempt is a superseded body that still runs, so it drops.
 */

/** Where one applied delta landed: `end` is the segment's length after the append. */
interface ChatDeltaMark {
  seq: number;
  segment: number;
  end: number;
}

/** Ordered text of one chat stream, rebuilt from `chat.delta` or `chat.reasoning` frames. */
export interface ChatDeltaLog {
  /** Committed before the log started. A `seq` at or below it always drops. */
  readonly floor: number;
  attempt: number;
  seq: number;
  readonly segments: Map<number, string>;
  /** One per applied delta, in `seq` order. Internal to the reducer; read `segments`. */
  readonly marks: ChatDeltaMark[];
}

/** `committedSeq` is the floor: the server fold passes the run's committed `deltaSeq`. */
export function createChatDeltaLog(committedSeq = 0): ChatDeltaLog {
  return { floor: committedSeq, attempt: 0, seq: committedSeq, segments: new Map(), marks: [] };
}

/** Apply one frame. `"rewound"` means text the caller already rendered was cut. */
export function applyChatDelta(
  log: ChatDeltaLog,
  delta: { seq: number; attempt: number; segment: number; text: string },
): "dropped" | "appended" | "rewound" {
  if (delta.seq <= log.floor || delta.attempt < log.attempt) return "dropped";
  let rewound = false;

  if (delta.attempt > log.attempt) {
    rewound = cutFrom(log, delta.seq);
    log.attempt = delta.attempt;
    log.seq = delta.seq - 1;
  }

  if (delta.seq <= log.seq) return "dropped";
  const text = (log.segments.get(delta.segment) ?? "") + delta.text;
  log.segments.set(delta.segment, text);
  log.marks.push({ seq: delta.seq, segment: delta.segment, end: text.length });
  log.seq = delta.seq;

  return rewound ? "rewound" : "appended";
}

/** Drop every mark at or above `cutSeq` and the text it added. Returns whether any was cut. */
function cutFrom(log: ChatDeltaLog, cutSeq: number): boolean {
  const first = log.marks.findIndex((mark) => mark.seq >= cutSeq);

  if (first === -1) return false;
  log.marks.splice(first);
  const ends = new Map<number, number>();

  for (const mark of log.marks) ends.set(mark.segment, mark.end);

  for (const [segment, text] of log.segments) {
    const end = ends.get(segment);

    if (end === undefined) log.segments.delete(segment);
    else log.segments.set(segment, text.slice(0, end));
  }

  return true;
}
