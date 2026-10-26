import {
  BRIEFING_LOOP_RELEVANCE_OBJECT_TITLE_MAX,
  briefingLoopRelevanceSchema,
  canonicalizeRailwayTargetId,
  getObjectDef,
  type INTEGRATION_OBJECT_DEFS,
  isBuiltInObjectStateProvider,
  parseGithubPullRequestUrl,
  sanitizeErrorMessage,
  typedKeys,
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
import {
  railwayTargetFromId,
  readRailwayDeploymentStatus,
  type RailwayPullTarget,
} from "@alfred/assistant/connections/verified-pull";
import { logger } from "@alfred/logging";

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
const MAX_RELEVANCE_OBJECTS = 5;

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

/** Reads the live native state of one object. It holds the parsed target, so it takes only the user. */
export type LiveNativeStateReader = (userId: string) => Promise<string>;

/** The parsed target each live reader reads. Each key is a `LoopRelevanceSource`. */
interface LiveTargetBySource {
  live_github_read: { owner: string; repo: string; number: number };
  /** The Sentry issue id. */
  live_sentry_read: string;
  live_railway_read: RailwayPullTarget;
}

type LiveReadSource = keyof LiveTargetBySource;

/** An object and its target, parsed one time. */
interface LiveRead<S extends LiveReadSource> {
  readonly state: ObjectState;
  readonly target: LiveTargetBySource[S];
}

interface LiveStateReader<S extends LiveReadSource> {
  /** The one parse of the object. `null`: this reader cannot read it. */
  readonly toTarget: (state: ObjectState) => LiveTargetBySource[S] | null;
  readonly readTargets: (
    userId: string,
    reads: readonly LiveRead<S>[],
    verdictByObject: Map<string, ObjectVerdict>,
    source: S,
  ) => Promise<void>;
  readonly readNativeState?: (userId: string, target: LiveTargetBySource[S]) => Promise<string>;
}

type LiveStateReaderBySource = [Exclude<LiveReadSource, LiveReadSourceByKindValue>] extends [never]
  ? { readonly [S in LiveReadSource]: LiveStateReader<S> }
  : { readonly [S in LiveReadSource]: LiveStateReader<S> } & {
      /** Present only when a live-read source owns no kind cell. Never set it by hand. */
      readonly missingKindCellFor: Exclude<LiveReadSource, LiveReadSourceByKindValue>;
    };

type LiveReadsBySource = { readonly [S in LiveReadSource]: LiveRead<S>[] };

/** One pass over the loop objects. */
interface LiveReadPlan {
  /** The admitted reads, at most {@link MAX_RELEVANCE_OBJECTS} distinct objects in all. */
  readonly reads: LiveReadsBySource;
  /** Every object that a reader can read, admitted or not. */
  readonly readableRefs: ReadonlySet<string>;
}

type RegisteredObjectKinds<Provider extends ObjectStateProvider> =
  keyof (typeof INTEGRATION_OBJECT_DEFS)[Provider]["kinds"];

type LiveReadSourceTable = {
  readonly [Provider in ObjectStateProvider]: {
    readonly [Kind in RegisteredObjectKinds<Provider>]: LiveReadSource | null;
  };
};

/**
 * The live reader per object kind. Typed from `INTEGRATION_OBJECT_DEFS`, so a new kind
 * fails to compile until it is listed here. Unread kinds are an explicit `null`.
 */
const LIVE_READ_SOURCE_BY_KIND = {
  github: {
    pull_request: "live_github_read",
    ci_attempt: null,
    ci_target: null,
  },
  sentry: {
    issue: "live_sentry_read",
  },
  railway: {
    deployment_attempt: null,
    deployment_target: "live_railway_read",
  },
  vercel: {
    deployment_attempt: null,
    deployment_target: null,
  },
  mcp: {
    // MCP health arrives already folded per connection; this table holds fixed readers only.
    connection_health: null,
  },
} as const satisfies LiveReadSourceTable;

/**
 * Every live-read source must own at least one kind cell above, or its reader
 * never runs. `LiveStateReaderBySource` resolves against this union, so a
 * reader with no kind cell fails to compile.
 */
type LiveReadSourceByKindValue = {
  [Provider in ObjectStateProvider]: (typeof LIVE_READ_SOURCE_BY_KIND)[Provider][keyof (typeof LIVE_READ_SOURCE_BY_KIND)[Provider]];
}[ObjectStateProvider];

const LIVE_STATE_READERS: LiveStateReaderBySource = {
  live_github_read: {
    toTarget: (state) => {
      const parsed = parseGithubPullRequestUrl(state.url ?? "");

      if (!parsed) return null;

      const slash = parsed.repoFullName.indexOf("/");

      return {
        owner: parsed.repoFullName.slice(0, slash),
        repo: parsed.repoFullName.slice(slash + 1),
        number: parsed.number,
      };
    },
    readTargets: readGithubTargets,
  },
  live_sentry_read: {
    toTarget: (state) => state.externalId,
    readTargets: readSentryTargets,
    readNativeState: async (userId, issueId) =>
      (await readLiveSentryIssue({ userId, issueId })).nativeState,
  },
  live_railway_read: {
    toTarget: (state) => railwayTargetFromId(state.externalId),
    readTargets: readRailwayTargets,
    readNativeState: async (userId, target) => {
      const reading = await readRailwayDeploymentStatus(userId, target);

      if (!reading)
        throw new Error(
          `Railway live read proved nothing target=${canonicalizeRailwayTargetId(target)}`,
        );

      return reading.status;
    },
  },
};

function liveReadSource(state: ObjectState): LiveReadSource | null {
  for (const [kind, source] of Object.entries<LiveReadSource | null>(
    LIVE_READ_SOURCE_BY_KIND[state.provider],
  )) {
    if (kind === state.kind) return source;
  }

  return null;
}

/** The relevance reader, reused for a closure live confirmation. */
export function liveNativeStateReader(state: ObjectState): LiveNativeStateReader | null {
  const source = liveReadSource(state);

  return source ? bindNativeStateReader(source, state) : null;
}

function bindNativeStateReader<S extends LiveReadSource>(
  source: S,
  state: ObjectState,
): LiveNativeStateReader | null {
  const reader = LIVE_STATE_READERS[source];
  const read = reader.readNativeState;

  if (!read) return null;

  const target = reader.toTarget(state);

  return target === null ? null : (userId) => read(userId, target);
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
    logger.warn({ err }, "[briefing.relevance] pass failed, all loops unverified");

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
  const plan = planLiveReads(objects);

  await Promise.all(
    typedKeys(LIVE_STATE_READERS).map((source) =>
      runLiveReads(args.userId, source, plan.reads, verdictByObject),
    ),
  );

  return finalizeLoopRelevanceVerdicts({
    loops: args.loops,
    objectByLoop,
    readableRefs: plan.readableRefs,
    verdictByObject,
    approvedStates: args.approvedStates,
    unverifiedDetails: args.unverifiedDetails,
  });
}

/**
 * Fan reads out to one verdict per loop. Readers only build non-closing verdicts,
 * and every verdict passes {@link briefingLoopRelevanceSchema}; a rejection becomes `unverifiable`.
 */
function finalizeLoopRelevanceVerdicts(args: {
  loops: readonly RelevanceLoop[];
  objectByLoop: ReadonlyMap<string, ObjectState | null>;
  readableRefs: ReadonlySet<string>;
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

      if (!args.readableRefs.has(ref)) {
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

    if (!args.readableRefs.has(ref)) {
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

/**
 * One parse per distinct object, in loop order. The first {@link MAX_RELEVANCE_OBJECTS}
 * readable objects are admitted across providers; the rest are readable but not read.
 */
function planLiveReads(objects: readonly ObjectState[]): LiveReadPlan {
  const reads: LiveReadsBySource = {
    live_github_read: [],
    live_sentry_read: [],
    live_railway_read: [],
  };

  const readableRefs = new Set<string>();

  for (const state of objects) {
    const ref = objectRef(state);

    if (readableRefs.has(ref)) continue;

    const source = liveReadSource(state);

    if (!source) continue;

    const admit = readableRefs.size < MAX_RELEVANCE_OBJECTS;

    // An unparsable occurrence leaves the ref open, so a later one can still read it.
    if (addLiveRead(reads, source, state, admit)) readableRefs.add(ref);
  }

  return { reads, readableRefs };
}

/** False when the source's reader cannot read the object. */
function addLiveRead<S extends LiveReadSource>(
  reads: LiveReadsBySource,
  source: S,
  state: ObjectState,
  admit: boolean,
): boolean {
  const target = LIVE_STATE_READERS[source].toTarget(state);

  if (target === null) return false;

  if (admit) reads[source].push({ state, target });

  return true;
}

/** Each source's reads go to that source's reader only. */
function runLiveReads<S extends LiveReadSource>(
  userId: string,
  source: S,
  reads: LiveReadsBySource,
  verdictByObject: Map<string, ObjectVerdict>,
): Promise<void> {
  return LIVE_STATE_READERS[source].readTargets(userId, reads[source], verdictByObject, source);
}

function objectRef(state: ObjectState): string {
  return `${state.provider}:${state.kind}:${state.externalId}`;
}

async function readSentryTargets(
  userId: string,
  reads: readonly LiveRead<"live_sentry_read">[],
  verdictByObject: Map<string, ObjectVerdict>,
  source: "live_sentry_read",
): Promise<void> {
  await Promise.all(
    reads.map(async ({ state, target: issueId }) => {
      const ref = objectRef(state);

      try {
        const live = await readLiveSentryIssue({ userId, issueId });

        verdictByObject.set(
          ref,
          verdictFromNativeState({
            state,
            nativeState: live.nativeState,
            detail: `Sentry live read reports issue ${issueId} as ${live.nativeState}.`,
            source,
          }),
        );
      } catch (err) {
        logger.warn({ err }, `[briefing.relevance] sentry live read failed object=${ref}`);
        verdictByObject.set(
          ref,
          unverified(state, "Sentry live read failed; loop stays live.", source),
        );
      }
    }),
  );
}

async function readRailwayTargets(
  userId: string,
  reads: readonly LiveRead<"live_railway_read">[],
  verdictByObject: Map<string, ObjectVerdict>,
  source: "live_railway_read",
): Promise<void> {
  await Promise.all(
    reads.map(async ({ state, target }) => {
      const ref = objectRef(state);
      // Never throws: a fault, a missing connection or an unknown status is `null`.
      const reading = await readRailwayDeploymentStatus(userId, target);

      if (!reading) {
        logger.warn(`[briefing.relevance] railway live read proved nothing object=${ref}`);
        verdictByObject.set(
          ref,
          unverified(state, "Railway live read proved nothing; loop stays live.", source),
        );

        return;
      }

      verdictByObject.set(
        ref,
        verdictFromNativeState({
          state,
          nativeState: reading.status,
          detail: `Railway live read reports the latest deployment of ${state.title ?? state.externalId} as ${reading.status}.`,
          source,
        }),
      );
    }),
  );
}

async function readGithubTargets(
  userId: string,
  reads: readonly LiveRead<"live_github_read">[],
  verdictByObject: Map<string, ObjectVerdict>,
  source: "live_github_read",
): Promise<void> {
  if (reads.length === 0) return;

  let batch: Awaited<ReturnType<ReturnType<typeof githubClientForUser>["getPullRequests"]>>;

  try {
    // One batch call, one attempt. Per-item faults land in `failed`; a total fault
    // makes every target unverified.
    batch = await githubClientForUser({ userId, retry: "none" }).getPullRequests(
      reads.map((read) => read.target),
    );
  } catch (err) {
    logger.warn({ err }, "[briefing.relevance] github live read failed");

    for (const { state } of reads) {
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

  for (const { state, target: coord } of reads) {
    const ref = objectRef(state);
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

  logger.warn("[briefing.relevance] contract rejected a verdict; loop stays unverified");

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
