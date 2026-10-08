import {
  BRIEFING_LOOP_RELEVANCE_OBJECT_TITLE_MAX,
  briefingLoopRelevanceSchema,
  getObjectDef,
  INTEGRATION_OBJECT_DEFS,
  isBuiltInObjectStateProvider,
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
import {
  selectPrimaryReconciledObject,
  type ObjectState,
  type ReconcileResult,
} from "@alfred/assistant/connections";

/**
 * Check-before-remind relevance (#1194), between reconciliation and compose.
 * Reads each live loop with read-only provider tools and returns one cited verdict per loop.
 * Verdicts shape phrasing and priority only. Nothing here can close a loop; closure
 * stays with verified state in the store (ADR-0048 D, ADR-0103).
 * At most {@link MAX_RELEVANCE_OBJECTS} objects get one read each; the rest, and any
 * fault or missing reader, are `unverifiable`. Failure always leaves the loop live.
 * A gather-time read over a user's own grant, so it needs no approval.
 */

/** Distinct objects one briefing reads live. Same as `MAX_VERIFIED_PULL_TARGETS`. */
export const MAX_RELEVANCE_OBJECTS = 5;

/** In gather order, before the per-bucket cap. */
export interface RelevanceLoop {
  documentId: string;
}

/** Store state from an owner-approved MCP health read. */
export interface ApprovedLoopState {
  state: ObjectState;
  detail: string;
}

/** One object's read, before fan-out to its loops. */
type ObjectVerdict = Omit<BriefingLoopRelevance, "documentId">;

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
 * Live readers per object kind. Typed from `INTEGRATION_OBJECT_DEFS`, so a new kind
 * fails to compile until it is listed here. Unread kinds are an explicit `null`.
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
  mcp: {
    // MCP health arrives already folded per connection; this table holds fixed readers only.
    connection_health: null,
  },
} as const satisfies LiveStateReaderTable;

function liveStateReaderRegistration(state: ObjectState): LiveStateReaderRegistration | null {
  const registrations = LIVE_STATE_READERS[state.provider];

  for (const [kind, registration] of Object.entries(registrations)) {
    if (kind === state.kind && registration?.accepts(state)) return registration;
  }

  return null;
}

/** The relevance reader, reused for a closure live confirmation. */
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

/** One verdict per loop, in order. Never throws: a total fault gives `unverifiable` for each. */
export async function assessLoopRelevance(args: {
  userId: string;
  loops: readonly RelevanceLoop[];
  reconciled: ReconcileResult<"about">;
  approvedStates?: ReadonlyMap<string, ApprovedLoopState> | undefined;
  unverifiedDetails?: ReadonlyMap<string, string> | undefined;
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
  approvedStates?: ReadonlyMap<string, ApprovedLoopState> | undefined;
  unverifiedDetails?: ReadonlyMap<string, string> | undefined;
}): Promise<BriefingLoopRelevance[]> {
  // A built-in object is the loop's identity when there is one; else the first MCP object.
  const objectByLoop = new Map<string, ObjectState | null>();

  for (const loop of args.loops) {
    const resolved = args.reconciled.get(loop.documentId) ?? [];

    // Shared precedence: a built-in object wins; MCP counts only when there is none.
    const state = selectPrimaryReconciledObject(resolved)?.state ?? null;

    objectByLoop.set(loop.documentId, state);
  }

  const objects = [...objectByLoop.values()].filter((state) => state !== null);
  const verdictByObject = new Map<string, ObjectVerdict>();
  const targetsByReader = new Map<LiveStateReaderRegistration, ObjectState[]>();

  for (const state of selectRelevanceReadTargets(objects)) {
    const reader = liveStateReaderRegistration(state);

    // Selection used the same registration, so this is never null here.
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
    approvedStates: args.approvedStates,
    unverifiedDetails: args.unverifiedDetails,
  });
}

/**
 * Fan reads out to one verdict per loop. Readers only build non-closing verdicts,
 * and every verdict passes {@link briefingLoopRelevanceSchema}; a rejection becomes `unverifiable`.
 */
export function finalizeLoopRelevanceVerdicts(args: {
  loops: readonly RelevanceLoop[];
  objectByLoop: ReadonlyMap<string, ObjectState | null>;
  verdictByObject: ReadonlyMap<string, ObjectVerdict>;
  approvedStates?: ReadonlyMap<string, ApprovedLoopState> | undefined;
  unverifiedDetails?: ReadonlyMap<string, string> | undefined;
}): BriefingLoopRelevance[] {
  return args.loops.map((loop) => {
    const state = args.objectByLoop.get(loop.documentId) ?? null;

    // A built-in provider's verdict wins, even `unverifiable`. MCP adds evidence only
    // for a loop with no built-in object.
    if (state && isBuiltInObjectStateProvider(state.provider)) {
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
    }

    const approved = args.approvedStates?.get(loop.documentId);

    if (approved) {
      return toVerdict(loop.documentId, {
        verdict: VERDICT_BY_STATE_CATEGORY[approved.state.stateCategory],
        source: "live_mcp_read",
        observedState: approved.state.nativeState,
        objectTitle: approved.state.title,
        objectUrl: httpsUrlOrNull(approved.state.url),
        detail: approved.detail,
      });
    }

    if (!state) {
      const detail =
        args.unverifiedDetails?.get(loop.documentId) ??
        "No linked work object; nothing to re-check, loop stays live.";

      return toVerdict(loop.documentId, unverified(null, detail));
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

/** The first distinct readable objects, capped across providers. */
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

    // `LIVE_STATE_READERS` already admitted this URL; this guard only narrows the type.
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
    // One batch call, one attempt. Per-item faults land in `failed`; a total fault
    // makes every target unverified.
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

    // `merged` comes from GitHub's boolean; the registry decides what each token means.
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

/** Check the evidence fields at the composer boundary. A rejected shape becomes `unverifiable` and is logged. */
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
