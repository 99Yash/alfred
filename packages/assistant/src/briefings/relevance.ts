import {
  BRIEFING_LOOP_RELEVANCE_OBJECT_TITLE_MAX,
  briefingLoopRelevanceSchema,
  getObjectDef,
  INTEGRATION_OBJECT_DEFS,
  parseGithubPullRequestUrl,
  redactSecrets,
  sanitizeErrorMessage,
  toMessage,
  type BriefingLoopRelevance,
  type LoopRelevanceSource,
  type LoopRelevanceVerdict,
  type ObjectStateProvider,
  type StateCategory,
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

/** The closure path's live-native read shape, now registered beside relevance's readers. */
export type LiveNativeStateReader = (userId: string, externalId: string) => Promise<string>;

interface LiveStateReaderRegistration {
  readonly source: Exclude<LoopRelevanceSource, "none">;
  readonly accepts: (state: ObjectState) => boolean;
  readonly readTargets: (
    userId: string,
    targets: readonly ObjectState[],
    verdictByObject: Map<string, ObjectVerdict>,
    source: Exclude<LoopRelevanceSource, "none">,
  ) => Promise<void>;
  readonly readNativeState?: LiveNativeStateReader;
}

type RegisteredObjectKinds<Provider extends ObjectStateProvider> =
  keyof (typeof INTEGRATION_OBJECT_DEFS)[Provider]["kinds"];

type LiveStateReaderTable = {
  readonly [Provider in ObjectStateProvider]: {
    readonly [Kind in RegisteredObjectKinds<Provider>]: LiveStateReaderRegistration | null;
  };
};

/**
 * Every object kind's live-read registration. The mapped type is derived from
 * `INTEGRATION_OBJECT_DEFS`, so adding a kind to the object-state registry
 * without making its relevance/closure reader choice here fails to compile.
 * Sentry and GitHub are the only current registrations; every other row is an
 * explicit `null`, never an inherited arm.
 */
const LIVE_STATE_READERS = {
  github: {
    pull_request: {
      source: "live_github_read",
      accepts: (state) => parseGithubPullRequestUrl(state.url ?? "") !== null,
      readTargets: readGithubTargets,
    },
    ci_attempt: null,
    ci_target: null,
  },
  sentry: {
    issue: {
      source: "live_sentry_read",
      accepts: () => true,
      readTargets: readSentryTargets,
      readNativeState: async (userId, issueId) =>
        (await readLiveSentryIssue({ userId, issueId })).nativeState,
    },
  },
  railway: {
    deployment_attempt: null,
    deployment_target: null,
  },
  vercel: {
    deployment_attempt: null,
    deployment_target: null,
  },
} as const satisfies LiveStateReaderTable;

function liveStateReaderRegistration(state: ObjectState): LiveStateReaderRegistration | null {
  const registrations = LIVE_STATE_READERS[state.provider];

  for (const [kind, registration] of Object.entries(registrations)) {
    if (kind === state.kind && registration?.accepts(state)) return registration;
  }

  return null;
}

/** The same registry-backed reader used by relevance, for a closure live confirmation. */
export function liveNativeStateReader(state: ObjectState): LiveNativeStateReader | null {
  return liveStateReaderRegistration(state)?.readNativeState ?? null;
}

const VERDICT_BY_STATE_CATEGORY = {
  active: "still-actionable",
  failed: "still-actionable",
  resolved: "stale-but-open",
  abandoned: "stale-but-open",
} as const satisfies Record<StateCategory, LoopRelevanceVerdict>;

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

function verdictFromNativeState(args: {
  state: ObjectState;
  nativeState: string;
  observedState?: string;
  detail: string;
  source: Exclude<LoopRelevanceSource, "none">;
  stale?: boolean;
}): ObjectVerdict {
  const stateCategory = getObjectDef(args.state.provider).normalize(
    args.state.kind,
    args.nativeState,
  );

  if (!stateCategory) {
    return unverified(args.state, args.detail, args.source);
  }

  return {
    verdict: args.stale ? "stale-but-open" : VERDICT_BY_STATE_CATEGORY[stateCategory],
    source: args.source,
    observedState: args.observedState ?? args.nativeState,
    objectTitle: args.state.title,
    objectUrl: httpsUrlOrNull(args.state.url),
    detail: args.detail,
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
  const targetsByReader = new Map<LiveStateReaderRegistration, ObjectState[]>();

  for (const state of selectRelevanceReadTargets(objects)) {
    const reader = liveStateReaderRegistration(state);

    // Selection used this same registration, so the non-null reader is a
    // deterministic consequence rather than a second policy branch.
    if (!reader) continue;

    const targets = targetsByReader.get(reader) ?? [];
    targets.push(state);
    targetsByReader.set(reader, targets);
  }

  await Promise.all(
    [...targetsByReader].map(([reader, targets]) =>
      reader.readTargets(args.userId, targets, verdictByObject, reader.source),
    ),
  );

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
 * before it can reach the composer. The schema is now the boundary check for
 * bounded text and URL fields; the verdict vocabulary itself is compile-enforced
 * by `ObjectVerdict`. Any runtime boundary rejection degrades to `unverifiable`.
 */
export function finalizeLoopRelevanceVerdicts(args: {
  loops: readonly RelevanceLoop[];
  objectByLoop: ReadonlyMap<string, ObjectState | null>;
  verdictByObject: ReadonlyMap<string, ObjectVerdict>;
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

    const verdict = args.verdictByObject.get(ref);

    if (verdict !== undefined) {
      return toVerdict(loop.documentId, verdict);
    }

    if (!liveStateReaderRegistration(state)) {
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
    if (!liveStateReaderRegistration(state)) continue;

    const ref = objectRef(state);

    if (!distinct.has(ref)) distinct.set(ref, state);
  }

  return [...distinct.values()].slice(0, MAX_RELEVANCE_OBJECTS);
}

function objectRef(state: ObjectState): string {
  return `${state.provider}:${state.kind}:${state.externalId}`;
}

async function readSentryTargets(
  userId: string,
  targets: readonly ObjectState[],
  verdictByObject: Map<string, ObjectVerdict>,
  source: Exclude<LoopRelevanceSource, "none">,
): Promise<void> {
  await Promise.all(
    targets.map(async (state) => {
      const ref = objectRef(state);

      try {
        const live = await readLiveSentryIssue({ userId, issueId: state.externalId });

        verdictByObject.set(
          ref,
          verdictFromNativeState({
            state,
            nativeState: live.nativeState,
            detail: `Sentry live read reports issue ${state.externalId} as ${live.nativeState}.`,
            source,
          }),
        );
      } catch (err) {
        console.warn(
          `[briefing.relevance] sentry live read failed object=${ref} :: ${redactSecrets(toMessage(err))}`,
        );
        verdictByObject.set(
          ref,
          unverified(state, "Sentry live read failed; loop stays live.", source),
        );
      }
    }),
  );
}

async function readGithubTargets(
  userId: string,
  targets: readonly ObjectState[],
  verdictByObject: Map<string, ObjectVerdict>,
  source: Exclude<LoopRelevanceSource, "none">,
): Promise<void> {
  if (targets.length === 0) return;

  const coords = new Map<string, { owner: string; repo: string; number: number }>();

  for (const state of targets) {
    const parsed = parseGithubPullRequestUrl(state.url ?? "");

    // `LIVE_STATE_READERS` admitted this target, so the URL parsed; the guard is
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
        unverified(state, "GitHub live read failed; loop stays live.", source),
      );
    }

    return;
  }

  const failedRefs = new Set(
    batch.failed.map((item) => `${item.owner}/${item.repo}#${item.number}`),
  );

  for (const state of targets) {
    const ref = objectRef(state);
    const coord = coords.get(ref);

    if (!coord) {
      verdictByObject.set(
        ref,
        unverified(state, "GitHub live read failed; loop stays live.", source),
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
        ref,
        unverified(state, "GitHub live read proved nothing; loop stays live.", source),
      );
      continue;
    }

    // `merged` is the reducer-owned token when GitHub's booleans say a PR
    // merged; otherwise its state string is already the reducer vocabulary.
    // The shared registry, not this reader, decides what either token means.
    const nativeState = item.merged ? "merged" : item.state;
    const draft = !item.merged && item.state === "open" && item.draft;
    const observedState = draft ? "draft" : nativeState;

    verdictByObject.set(
      ref,
      verdictFromNativeState({
        state,
        nativeState,
        observedState,
        stale: draft,
        detail: draft
          ? `GitHub live read reports ${providerRef} open as a draft.`
          : `GitHub live read reports ${providerRef} ${observedState}.`,
        source,
      }),
    );
  }
}

/**
 * Validate the bounded evidence fields at the composer boundary. The verdict
 * vocabulary and source are already compile-enforced; a runtime shape that the
 * contract still rejects degrades to an honest `unverifiable` and is reported.
 */
function toVerdict(documentId: string, verdict: ObjectVerdict): BriefingLoopRelevance {
  const parsed = briefingLoopRelevanceSchema.safeParse({
    documentId,
    ...verdict,
    objectTitle:
      verdict.objectTitle === null
        ? null
        : sanitizeErrorMessage(verdict.objectTitle, BRIEFING_LOOP_RELEVANCE_OBJECT_TITLE_MAX),
  });

  if (parsed.success) return parsed.data;

  console.warn("[briefing.relevance] contract rejected a verdict; loop stays unverified");

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
