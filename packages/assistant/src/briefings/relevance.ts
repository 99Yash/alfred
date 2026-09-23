import {
  briefingLoopRelevanceSchema,
  isRecord,
  parseGithubPullRequestUrl,
  redactSecrets,
  toMessage,
  type BriefingLoopRelevance,
  type LoopRelevanceSource,
} from "@alfred/contracts";
import { githubClientForUser } from "@alfred/integrations/github";
import { readLiveSentryIssue } from "@alfred/integrations/sentry";
import { type ObjectState, type ReconcileResult } from "@alfred/assistant/connections";

/**
 * Check-before-remind relevance (#1194) — the bounded pass between
 * deterministic loop reconciliation and the composer.
 *
 * For each still-live loop it verifies at runtime whether the loop is still
 * worth the user's attention, using read-only provider tools. It returns one
 * structured verdict per loop with cited evidence. Verdicts shape phrasing and
 * priority ONLY — this module has no write tool, mints no receipt, folds
 * nothing into the object-state store, and returns no closure claim, so it
 * cannot close a loop by construction. Closure stays exclusively with verified
 * push/pull state folded through the store (ADR-0048-D, ADR-0103).
 *
 * Bounding (the #1192 shapes, reused not re-derived): at most
 * {@link MAX_RELEVANCE_OBJECTS} distinct objects get a live read per briefing,
 * one read per object no matter how many loops name it, loops past the budget
 * read as `unverifiable`. Unknown output, a faulted read, a loop with no
 * linked object, and a kind with no live reader all degrade to `unverifiable`
 * — the fail direction is always live, never closed (#1193 lesson).
 *
 * Approval posture: a deterministic gather-time read over a user-connected
 * grant — the calendar/weather gatherer pattern — so it bypasses
 * staging/approval by construction and holds no write tool.
 */

/** How many distinct objects one briefing live-reads. Mirrors `MAX_VERIFIED_PULL_TARGETS`. */
export const MAX_RELEVANCE_OBJECTS = 5;

/** One still-live priority loop, in deterministic gather order before presentation capping. */
export interface RelevanceLoop {
  documentId: string;
}

/** A live read's outcome for one object, before it is fanned out to loops. */
type ObjectVerdict = Omit<BriefingLoopRelevance, "documentId">;

function httpsUrlOrNull(value: string | null): string | null {
  return value && value.startsWith("https://") ? value : null;
}

function unverified(
  state: ObjectState | null,
  detail: string,
  source: LoopRelevanceSource = "none",
): ObjectVerdict {
  return {
    verdict: "unverifiable",
    source,
    observedState: null,
    objectTitle: state?.title ?? null,
    objectUrl: httpsUrlOrNull(state?.url ?? null),
    detail,
  };
}

/**
 * One verdict per loop, in loop order. Never throws: a total fault resolves to
 * one `unverifiable` verdict per loop, so every loop still carries a verdict
 * and every loop stays live (ADR-0048-D).
 */
export async function assessLoopRelevance(args: {
  userId: string;
  loops: readonly RelevanceLoop[];
  reconciled: ReconcileResult<"about">;
}): Promise<BriefingLoopRelevance[]> {
  try {
    return await assessLoopRelevanceInner(args);
  } catch (err) {
    console.warn(
      `[briefing.relevance] pass failed, all loops unverified :: ${redactSecrets(toMessage(err))}`,
    );

    return args.loops.map((loop) =>
      toVerdict(loop.documentId, unverified(null, "Relevance pass faulted; loop unverified.")),
    );
  }
}

async function assessLoopRelevanceInner(args: {
  userId: string;
  loops: readonly RelevanceLoop[];
  reconciled: ReconcileResult<"about">;
}): Promise<BriefingLoopRelevance[]> {
  // The FIRST resolved object is the loop's primary identity — the same
  // precedence `reconcileEvidence` reports in. Selection below dedupes those
  // identities and applies one cross-provider read budget.
  const objectByLoop = new Map<string, ObjectState | null>();

  for (const loop of args.loops) {
    objectByLoop.set(loop.documentId, args.reconciled.get(loop.documentId)?.[0]?.state ?? null);
  }

  const objects = [...objectByLoop.values()].filter((state) => state !== null);
  const verdictByObject = new Map<string, ObjectVerdict>();
  const readable = selectRelevanceReadTargets(objects);

  const sentryTargets = readable.filter((state) => state.provider === "sentry");

  const githubTargets = readable.filter(
    (state) => state.provider === "github" && state.kind === "pull_request",
  );

  await Promise.all([
    readSentryTargets(args.userId, sentryTargets, verdictByObject),
    readGithubTargets(args.userId, githubTargets, verdictByObject),
  ]);

  return finalizeLoopRelevanceVerdicts({
    loops: args.loops,
    objectByLoop,
    verdictByObject,
  });
}

/**
 * Fan live reads back out to one contract-valid verdict per loop.
 *
 * The object read is kept separate from the per-loop fan-out so the never-close
 * invariant is structural at both points: readers construct only the three
 * non-closing verdicts, and every value crosses {@link briefingLoopRelevanceSchema}
 * before it can reach the composer. A malformed value (including a forged
 * `closed` token) therefore degrades to `unverifiable`; it cannot become a
 * closure claim or make a loop disappear.
 */
export function finalizeLoopRelevanceVerdicts(args: {
  loops: readonly RelevanceLoop[];
  objectByLoop: ReadonlyMap<string, ObjectState | null>;
  verdictByObject: ReadonlyMap<string, unknown>;
}): BriefingLoopRelevance[] {
  return args.loops.map((loop) => {
    const state = args.objectByLoop.get(loop.documentId) ?? null;

    if (!state) {
      return toVerdict(
        loop.documentId,
        unverified(null, "No linked work object; nothing to re-check, loop stays live."),
      );
    }

    const ref = objectRef(state);

    if (args.verdictByObject.has(ref)) {
      return toVerdict(loop.documentId, args.verdictByObject.get(ref));
    }

    if (!hasLiveReader(state)) {
      return toVerdict(
        loop.documentId,
        unverified(state, "No live reader for this loop's object kind; loop stays live."),
      );
    }

    return toVerdict(
      loop.documentId,
      unverified(state, "Live-read budget exhausted; loop stays live unverified."),
    );
  });
}

/** The first distinct readable objects, capped across all providers for one briefing. */
export function selectRelevanceReadTargets(
  objects: readonly ObjectState[],
): readonly ObjectState[] {
  const distinct = new Map<string, ObjectState>();

  for (const state of objects) {
    if (!hasLiveReader(state)) continue;

    const ref = objectRef(state);

    if (!distinct.has(ref)) distinct.set(ref, state);
  }

  return [...distinct.values()].slice(0, MAX_RELEVANCE_OBJECTS);
}

/**
 * Whether this build can live-read the object's current state. Sentry issues
 * read over the stored org credential; GitHub PRs read over the App
 * installation token from the stored canonical PR URL. Every other
 * provider/kind has no reader, so its loops read as `unverifiable`.
 */
function hasLiveReader(state: ObjectState): boolean {
  if (state.provider === "sentry" && state.kind === "issue") return true;

  if (
    state.provider === "github" &&
    state.kind === "pull_request" &&
    parseGithubPullRequestUrl(state.url ?? "") !== null
  ) {
    return true;
  }

  return false;
}

function objectRef(state: ObjectState): string {
  return `${state.provider}:${state.kind}:${state.externalId}`;
}

async function readSentryTargets(
  userId: string,
  targets: readonly ObjectState[],
  verdictByObject: Map<string, ObjectVerdict>,
): Promise<void> {
  await Promise.all(
    targets.map(async (state) => {
      const ref = objectRef(state);

      try {
        const live = await readLiveSentryIssue({ userId, issueId: state.externalId });

        // `readLiveSentryIssue` translates Sentry's REST vocabulary to the
        // stored one at its own boundary, so this switch reads stored tokens.
        // Every named state is classified explicitly. A future/unknown token
        // degrades instead of inheriting the archived branch (#1193).
        switch (live.nativeState) {
          case "unresolved":
            verdictByObject.set(ref, {
              verdict: "still-actionable",
              source: "live_sentry_read",
              observedState: live.nativeState,
              objectTitle: state.title,
              objectUrl: httpsUrlOrNull(state.url),
              detail: `Sentry live read still reports issue ${state.externalId} as unresolved.`,
            });
            break;
          case "resolved":
            verdictByObject.set(ref, {
              verdict: "stale-but-open",
              source: "live_sentry_read",
              observedState: live.nativeState,
              objectTitle: state.title,
              objectUrl: httpsUrlOrNull(state.url),
              detail: `Sentry live read reports issue ${state.externalId} resolved.`,
            });
            break;
          case "archived":
            verdictByObject.set(ref, {
              verdict: "stale-but-open",
              source: "live_sentry_read",
              observedState: live.nativeState,
              objectTitle: state.title,
              objectUrl: httpsUrlOrNull(state.url),
              detail: `Sentry live read reports issue ${state.externalId} archived.`,
            });
            break;
          default:
            verdictByObject.set(
              ref,
              unverified(
                state,
                "Sentry reported an unknown issue state; loop stays live.",
                "live_sentry_read",
              ),
            );
        }
      } catch (err) {
        console.warn(
          `[briefing.relevance] sentry live read failed object=${ref} :: ${redactSecrets(toMessage(err))}`,
        );
        verdictByObject.set(
          ref,
          unverified(state, "Sentry live read failed; loop stays live.", "live_sentry_read"),
        );
      }
    }),
  );
}

async function readGithubTargets(
  userId: string,
  targets: readonly ObjectState[],
  verdictByObject: Map<string, ObjectVerdict>,
): Promise<void> {
  if (targets.length === 0) return;

  const coords = new Map<string, { owner: string; repo: string; number: number }>();

  for (const state of targets) {
    const parsed = parseGithubPullRequestUrl(state.url ?? "");

    // `hasLiveReader` admitted this target, so the URL parsed; the guard is
    // the deterministic-input floor, not a second opinion.
    if (parsed) {
      const slash = parsed.repoFullName.indexOf("/");
      coords.set(objectRef(state), {
        owner: parsed.repoFullName.slice(0, slash),
        repo: parsed.repoFullName.slice(slash + 1),
        number: parsed.number,
      });
    }
  }

  let batch: Awaited<ReturnType<ReturnType<typeof githubClientForUser>["getPullRequests"]>>;

  try {
    // One batch call, exactly one attempt (`retry: "none"`): the batch fans
    // out under its own bounded concurrency, per-item faults land in
    // `failed`, and a total fault (no credential, no transport) degrades
    // every target to unverified below.
    batch = await githubClientForUser({ userId, retry: "none" }).getPullRequests([
      ...coords.values(),
    ]);
  } catch (err) {
    console.warn(
      `[briefing.relevance] github live read failed :: ${redactSecrets(toMessage(err))}`,
    );

    for (const state of targets) {
      verdictByObject.set(
        objectRef(state),
        unverified(state, "GitHub live read failed; loop stays live.", "live_github_read"),
      );
    }

    return;
  }

  const failedRefs = new Set(
    batch.failed.map((item) => `${item.owner}/${item.repo}#${item.number}`),
  );

  for (const state of targets) {
    const coord = coords.get(objectRef(state));

    if (!coord) {
      verdictByObject.set(
        objectRef(state),
        unverified(state, "GitHub live read failed; loop stays live.", "live_github_read"),
      );
      continue;
    }

    const repoFullName = `${coord.owner}/${coord.repo}`;
    const providerRef = `${repoFullName}#${coord.number}`;

    const matches = batch.items.filter(
      (pr) =>
        pr.repository.toLowerCase() === repoFullName.toLowerCase() && pr.number === coord.number,
    );

    const [item] = matches;

    if (!item || matches.length !== 1 || failedRefs.has(providerRef)) {
      verdictByObject.set(
        objectRef(state),
        unverified(state, "GitHub live read proved nothing; loop stays live.", "live_github_read"),
      );
      continue;
    }

    // A merged or closed PR demotes to stale-but-open, NEVER closes: the
    // reducer-owned projection may lag this live read, and only a verified
    // store fold carries closure authority. Byte-exact on the provider enum:
    // any other `state` token reads as unknown, and absence never closes.
    if (item.merged || item.state === "closed") {
      verdictByObject.set(objectRef(state), {
        verdict: "stale-but-open",
        source: "live_github_read",
        observedState: item.merged ? "merged" : item.state,
        objectTitle: state.title,
        objectUrl: httpsUrlOrNull(state.url),
        detail: item.merged
          ? `GitHub live read reports ${providerRef} merged.`
          : `GitHub live read reports ${providerRef} closed without a merge.`,
      });
    } else if (item.state === "open" && !item.draft) {
      verdictByObject.set(objectRef(state), {
        verdict: "still-actionable",
        source: "live_github_read",
        observedState: item.state,
        objectTitle: state.title,
        objectUrl: httpsUrlOrNull(state.url),
        detail: `GitHub live read still reports ${providerRef} open.`,
      });
    } else if (item.state === "open" && item.draft) {
      verdictByObject.set(objectRef(state), {
        verdict: "stale-but-open",
        source: "live_github_read",
        observedState: "draft",
        objectTitle: state.title,
        objectUrl: httpsUrlOrNull(state.url),
        detail: `GitHub live read reports ${providerRef} open as a draft.`,
      });
    } else {
      verdictByObject.set(
        objectRef(state),
        unverified(
          state,
          "GitHub reported an unknown PR state; loop stays live.",
          "live_github_read",
        ),
      );
    }
  }
}

/**
 * Validate each verdict against the contract at the owning boundary, so a
 * malformed construction degrades to an honest `unverifiable` instead of
 * reaching the composer. The `detail` floor keeps the schema's `min(1)`.
 */
function toVerdict(documentId: string, verdict: unknown): BriefingLoopRelevance {
  const parsed = isRecord(verdict)
    ? briefingLoopRelevanceSchema.safeParse({ documentId, ...verdict })
    : null;

  if (parsed?.success) return parsed.data;

  return {
    documentId,
    verdict: "unverifiable",
    source: "none",
    observedState: null,
    objectTitle: null,
    objectUrl: null,
    detail: "Relevance verdict malformed; loop stays live.",
  };
}
