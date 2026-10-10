/**
 * The one dedupe rule for `chat.delta` and `chat.reasoning` frames. The web bubble and the
 * server's failed-closure fold both apply it in outbox order, from a different floor.
 *
 * `attempt` grows on every step commit and on every stale-lease reclaim. Each frame carries
 * `fromSeq`, the committed `seq` its attempt started after. A higher attempt cuts every applied
 * frame above its `fromSeq`, so within one reclaim the cut does not depend on which of the new
 * attempt's frames arrives first. For a normal next step nothing sits above `fromSeq`, so
 * nothing is cut. A lower attempt is a superseded body that still runs, so it drops.
 *
 * Within one attempt, a frame at or below the highest applied `seq` drops. Delivery is not
 * ordered, so a frame that arrives after a higher `seq` of its own attempt is lost from the
 * stream until the saved row replaces it.
 *
 * The cut is not independent of order across steps. When a later step's frame arrives before
 * the reclaim attempt's frames, that step cuts only above its own `fromSeq`. The superseded
 * attempt's text below it stays, and the reclaim attempt's frames then drop as a lower attempt.
 * The bubble shows that splice until the terminal frame swaps in the saved row, which is correct.
 */

/** A point in the stream: the committed `deltaSeq` and `segmentIndex` of a run. */
interface ChatDeltaPosition {
  seq: number;
  segment: number;
}

/** Where one applied delta landed: `end` is the segment's length after the append. */
interface ChatDeltaMark {
  seq: number;
  segment: number;
  end: number;
}

/** Ordered text of one chat stream, rebuilt from `chat.delta` or `chat.reasoning` frames. */
export interface ChatDeltaLog {
  /**
   * Text already committed before the log started. A frame at or below `floor.seq`, or in a
   * segment below `floor.segment`, never appends, but its `attempt` still counts.
   */
  readonly floor: ChatDeltaPosition;
  /** The highest attempt seen. A frame from a lower attempt drops. */
  attempt: number;
  /** The highest `seq` applied in `attempt`, or the start point of `attempt`. */
  seq: number;
  readonly segments: Map<number, string>;
  /** One per applied delta, in `seq` order. Internal to the reducer; read `segments`. */
  readonly marks: ChatDeltaMark[];
}

/** The bubble starts at `{ seq: 0, segment: 0 }`; the server fold starts at the committed position. */
export function createChatDeltaLog(floor: ChatDeltaPosition): ChatDeltaLog {
  return { floor, attempt: 0, seq: floor.seq, segments: new Map(), marks: [] };
}

/**
 * Apply one frame. `"rewound"` means text the caller already rendered was cut; the frame itself
 * was then appended unless it sits at or below the floor.
 */
export function applyChatDelta(
  log: ChatDeltaLog,
  delta: { seq: number; attempt: number; fromSeq: number; segment: number; text: string },
): "dropped" | "appended" | "rewound" {
  if (delta.attempt < log.attempt) return "dropped";
  let rewound = false;

  // Read the attempt before the floor: a committed frame still raises it, so an older
  // attempt's uncommitted text above the floor is cut here as it is in the bubble.
  if (delta.attempt > log.attempt) {
    rewound = cutAbove(log, delta.fromSeq);
    log.attempt = delta.attempt;
    log.seq = Math.max(delta.fromSeq, log.floor.seq);
  }

  if (delta.seq <= log.seq || delta.segment < log.floor.segment) {
    return rewound ? "rewound" : "dropped";
  }

  const text = (log.segments.get(delta.segment) ?? "") + delta.text;
  log.segments.set(delta.segment, text);
  log.marks.push({ seq: delta.seq, segment: delta.segment, end: text.length });
  log.seq = delta.seq;

  return rewound ? "rewound" : "appended";
}

/** Drop every mark above `fromSeq` and the text it added. Returns whether any was cut. */
function cutAbove(log: ChatDeltaLog, fromSeq: number): boolean {
  const first = log.marks.findIndex((mark) => mark.seq > fromSeq);

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
