import {
  canonicalizeGithubPullRequestUrl,
  type INTEGRATION_OBJECT_DEFS,
  keyGuard,
  type ObjectIdentity,
  type ObjectStateProvider,
  parseGithubPullRequestUrl,
} from "@alfred/contracts";
import { githubClientForUser } from "@alfred/integrations/github";
import { logger } from "@alfred/logging";
import {
  deliveryInstantNow,
  GITHUB_PULL_REQUEST_READ_EVENT_TYPE,
  type DeliveryInstant,
  type GithubPullRequestReadEvent,
  type ObjectState,
  type VerifiedPullEvent,
} from "../object-state";
import { openVerifiedPullSession, type VerifiedPullProvider } from "./driver";
import { railwayVerifiedPullProvider } from "./railway";
import { vercelVerifiedPullProvider } from "./vercel";

/**
 * The loop verifier registry (ADR-0120 decision 6). One live reader for each object kind that a
 * loop can name. `verifyLoops` calls a reader only for a thing whose stored state is ambiguous
 * (decision 5). A reader writes nothing: it gives a provider fact, and `verifyLoops` folds every
 * fact of a run in one transaction (decision 7). A failed read gives `null`, never a state.
 */

/** One read that proved a state: the fact to fold, and the row that the fact folds into. */
export interface LoopVerifierRead {
  readonly fact: GithubPullRequestReadEvent | VerifiedPullEvent;
  readonly identity: ObjectIdentity;
  /**
   * The native token that the read saw. When the row after the fold holds another token, the
   * store refused the fact, and the read does not give the verdict.
   */
  readonly nativeState: string;
  /**
   * The instant before the request went out. The fold orders the fact by it, so a webhook that
   * arrives during the read or before the commit wins over the read.
   */
  readonly readAt: DeliveryInstant;
}

/** A key that a mail names, as the `email_interpretation` row stores it. */
export interface LoopKey {
  readonly keyKind: string;
  readonly keyValue: string;
}

/**
 * The reads of one run for one verifier. `plan` parses a thing one time and gives its target id.
 * `read` reads only the ids it gets, so the run cap can drop a planned target. It never throws: a
 * fault is `null` for each target that it covers.
 */
export interface LoopReadBatch {
  planState(state: ObjectState): string | null;
  /** A key with no stored row (case 3). `null` when this kind cannot read from a key. */
  planKey(key: LoopKey): string | null;
  read(
    userId: string,
    targetIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, LoopVerifierRead>>;
}

export interface LoopVerifier {
  /** The key kinds that `planKey` reads. Empty: the kind has no case-3 read. */
  readonly keyKinds: readonly string[];
  batch(): LoopReadBatch;
}

/** The typed half of a verifier. {@link defineLoopVerifier} keeps the target type inside. */
interface LoopVerifierDef<Target> {
  readonly keyKinds: readonly string[];
  targetFromState(state: ObjectState): Target | null;
  targetFromKey(key: LoopKey): Target | null;
  targetId(target: Target): string | null;
  /** One entry for each target that a read proved. A target with no entry failed. */
  readTargets(
    userId: string,
    targets: ReadonlyMap<string, Target>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, LoopVerifierRead>>;
}

function defineLoopVerifier<Target>(def: LoopVerifierDef<Target>): LoopVerifier {
  return {
    keyKinds: def.keyKinds,
    batch() {
      const planned = new Map<string, Target>();

      const plan = (target: Target | null): string | null => {
        if (target === null) return null;
        const id = def.targetId(target);

        if (id !== null) planned.set(id, target);

        return id;
      };

      return {
        planState: (state) => plan(def.targetFromState(state)),
        planKey: (key) =>
          def.keyKinds.includes(key.keyKind) ? plan(def.targetFromKey(key)) : null,
        async read(userId, targetIds, signal) {
          const admitted = new Map<string, Target>();

          for (const id of targetIds) {
            const target = planned.get(id);

            if (target !== undefined) admitted.set(id, target);
          }

          if (admitted.size === 0) return new Map();

          try {
            return await def.readTargets(userId, admitted, signal);
          } catch (err) {
            logger.warn({ err }, "[loops] live read failed; its things stay unverified");

            return new Map();
          }
        },
      };
    },
  };
}

interface GithubPullTarget {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

function githubPullTarget(url: string): GithubPullTarget | null {
  const canonical = canonicalizeGithubPullRequestUrl({ url });
  const parsed = canonical ? parseGithubPullRequestUrl(canonical) : null;

  if (!parsed) return null;

  const [owner, repo, ...rest] = parsed.repoFullName.split("/");

  return owner && repo && rest.length === 0 ? { owner, repo, number: parsed.number } : null;
}

/**
 * The GitHub REST pull request `state`, closed. A merged pull request is `closed` with
 * `merged: true`. A state outside this table gives no fact, so its thing stays unverified.
 */
const NATIVE_STATE_BY_GITHUB_PULL_STATE = {
  open: "open",
  closed: "closed",
} as const satisfies Record<
  "open" | "closed",
  GithubPullRequestReadEvent["payload"]["nativeState"]
>;

const isKnownGithubPullState = keyGuard(NATIVE_STATE_BY_GITHUB_PULL_STATE);

/**
 * One REST read for each pull request. `getPullRequests` sends the reads concurrently, because
 * GitHub has no batch read of pull requests.
 */
const githubPullRequestVerifier = defineLoopVerifier<GithubPullTarget>({
  keyKinds: ["pull_request_url"],
  targetFromState: (state) => (state.url ? githubPullTarget(state.url) : null),
  targetFromKey: (key) => githubPullTarget(key.keyValue),
  targetId: (target) =>
    canonicalizeGithubPullRequestUrl({
      repoFullName: `${target.owner}/${target.repo}`,
      number: target.number,
    }),
  async readTargets(userId, targets, signal) {
    const readAt = deliveryInstantNow();

    // One attempt. A fault of one item lands in `failed`, and its target gets no entry.
    const batch = await githubClientForUser({ userId, retry: "none" }).getPullRequests(
      [...targets.values()],
      { signal },
    );

    if (batch.failed.length > 0) {
      logger.warn(
        {
          count: batch.failed.length,
          failed: batch.failed.map((f) => ({
            pullRequest: `${f.owner}/${f.repo}#${f.number}`,
            error: f.error,
          })),
        },
        "[loops] github pull request reads failed; their things stay unverified",
      );
    }

    const reads = new Map<string, LoopVerifierRead>();
    const unknownStates = new Set<string>();

    for (const pr of batch.items) {
      const url = canonicalizeGithubPullRequestUrl({ url: pr.url });
      const parsed = url ? parseGithubPullRequestUrl(url) : null;

      if (!url || !parsed || !targets.has(url)) continue;

      if (!isKnownGithubPullState(pr.state)) {
        unknownStates.add(pr.state);
        continue;
      }

      const nativeState = pr.merged ? "merged" : NATIVE_STATE_BY_GITHUB_PULL_STATE[pr.state];

      const at =
        nativeState === "merged" ? pr.mergedAt : nativeState === "closed" ? pr.closedAt : null;

      const providerEventTime = at === null ? null : new Date(at);

      reads.set(url, {
        fact: {
          provider: "github",
          eventType: GITHUB_PULL_REQUEST_READ_EVENT_TYPE,
          payload: {
            githubId: pr.githubId,
            nativeState,
            providerEventTime:
              providerEventTime && !Number.isNaN(providerEventTime.getTime())
                ? providerEventTime
                : null,
            title: pr.title,
            url,
            repoFullName: parsed.repoFullName,
            number: parsed.number,
          },
        },
        identity: { provider: "github", kind: "pull_request", externalId: String(pr.githubId) },
        nativeState,
        readAt,
      });
    }

    if (unknownStates.size > 0) {
      logger.warn(
        { states: [...unknownStates] },
        "[loops] github pull request state unknown; its things stay unverified",
      );
    }

    return reads;
  },
});

/** A deploy target, read through its verified-pull provider: one session for each run. */
function deploymentTargetVerifier<E extends VerifiedPullEvent, Target, Session, Names>(
  provider: VerifiedPullProvider<E, Target, Session, Names>,
): LoopVerifier {
  return defineLoopVerifier<Target>({
    keyKinds: [],
    targetFromState: (state) => provider.targetFromRow(state),
    targetFromKey: () => null,
    targetId: (target) => provider.canonicalTargetId(target),
    async readTargets(userId, targets, signal) {
      const reads = new Map<string, LoopVerifierRead>();
      const opened = await openVerifiedPullSession(provider, userId, signal);

      if (opened === null) return reads;

      for (const [id, target] of targets) {
        const { reading, readAt } = await opened.read(target, id);

        // `absent` and a fault prove nothing, so the thing stays unverified.
        if (reading === null || reading === "absent") continue;

        reads.set(id, {
          fact: provider.mintReceipt(target, reading),
          identity: { provider: provider.provider, kind: provider.targetKind, externalId: id },
          // The reducer gives the target the read status as its token.
          nativeState: reading.status,
          readAt,
        });
      }

      return reads;
    },
  });
}

type RegisteredObjectKinds<Provider extends ObjectStateProvider> =
  keyof (typeof INTEGRATION_OBJECT_DEFS)[Provider]["kinds"];

type LoopVerifierTable = {
  readonly [Provider in ObjectStateProvider]: {
    readonly [Kind in RegisteredObjectKinds<Provider>]: LoopVerifier | null;
  };
};

/**
 * The reader for each object kind. Typed from `INTEGRATION_OBJECT_DEFS`, so a new kind does not
 * compile until it names a reader or an explicit `null`. For a deploy, the thing is the target:
 * an attempt never resolves.
 */
const LOOP_VERIFIERS = {
  github: {
    pull_request: githubPullRequestVerifier,
    ci_attempt: null,
    // No REST read of a branch's latest suite yet; the push folds every completed suite.
    ci_target: null,
  },
  railway: {
    deployment_attempt: null,
    deployment_target: deploymentTargetVerifier(railwayVerifiedPullProvider),
  },
  vercel: {
    deployment_attempt: null,
    deployment_target: deploymentTargetVerifier(vercelVerifiedPullProvider),
  },
  mcp: {
    // The approved health read folds per connection before `verifyLoops` runs (ADR-0120 slice 2).
    connection_health: null,
  },
} as const satisfies LoopVerifierTable;

/** The reader of one object kind, or `null` when the kind has none. */
export function loopVerifierFor(provider: ObjectStateProvider, kind: string): LoopVerifier | null {
  for (const [registered, verifier] of Object.entries<LoopVerifier | null>(
    LOOP_VERIFIERS[provider],
  )) {
    if (registered === kind) return verifier;
  }

  return null;
}

/** The reader that reads a thing from a key with no stored row (case 3), and its kind. */
export function loopVerifierForKey(
  provider: ObjectStateProvider,
  keyKind: string,
): { kind: string; verifier: LoopVerifier } | null {
  for (const [kind, verifier] of Object.entries<LoopVerifier | null>(LOOP_VERIFIERS[provider])) {
    if (verifier?.keyKinds.includes(keyKind)) return { kind, verifier };
  }

  return null;
}
