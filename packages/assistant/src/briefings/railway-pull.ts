import { canonicalizeRailwayTargetId, type IntegrationActivityItem } from "@alfred/contracts";
import { railwayClientForUser } from "@alfred/integrations/railway";
import { objectStateStore, type ObjectState } from "@alfred/assistant/connections";
import {
  builtInProviderForEndpoint,
  listOwnedConnections,
  RAILWAY_MCP_ISSUER,
} from "@alfred/assistant/connections/mcp";
import { RAILWAY_PULL_EVENT_TYPE } from "@alfred/assistant/connections/object-state/railway-reducer";

/**
 * The verified pull for failure-only providers (#1094) — the second named
 * closure source beside the verified push.
 *
 * Railway mails a build failure and stays silent on success, so email
 * evidence can observe the failure and can never observe the recovery. This
 * seam takes an authenticated read of CURRENT deployment state at gather
 * time instead: one read holds the whole answer, and a read proving a later
 * success closes the loop through the same store guards every push travels
 * (unknown kind/unknown token no-write, per-kind absorbing, the
 * `(providerEventTime, deliveredAt)` recency rule).
 *
 * Transport, honestly: the published remote MCP catalog carries NO
 * deployment-status tool (only `redeploy` + `accept-deploy`), so v1 reads
 * through the token-backed Railway GraphQL `deployments` query over the
 * user's own stored credential — an authenticated read of current state,
 * the same trust property as an MCP tool call, behind a different wire.
 * MCP-first stays the direction (epic #1002): the probe re-checks the live
 * catalog post-consent, and a status tool there upgrades the transport.
 *
 * Approval floors gate AGENT discretion; this deterministic gather-time read
 * over a user-connected grant is the calendar/weather gatherer pattern, so
 * it bypasses staging/approval by construction and holds no write tool.
 */

/** A Railway deployment target: the identity a pull reads. */
export interface RailwayPullTarget {
  projectId: string;
  serviceId: string;
  environmentId: string;
}

/** Display names for a target, best-effort — identity never depends on them. */
interface RailwayTargetNames {
  project: string;
  service: string;
  environment: string;
}

/**
 * What one authenticated read proved, parsed from `unknown` at the transport
 * boundary. `null` from the reader means the read failed, timed out, or
 * returned an unknown state — the caller mints nothing, so the loop stays
 * live (ADR-0048-D). A null is never a close.
 */
export interface ParsedRailwayStatus {
  status: "success" | "failure" | "pending";
  deploymentId: string;
  /** Provider-clock instant of the deployment, absent when the API names none. */
  providerEventTime: Date | null;
  url: string | null;
}

/**
 * Read current deployment state for one target over the user's stored
 * Railway credential. First answering credential wins; transport faults fall
 * through to the next credential, and an unknown status token is a
 * definitive unknown for this read — never a guessed state.
 */
export async function readRailwayDeploymentStatus(
  userId: string,
  target: RailwayPullTarget,
): Promise<ParsedRailwayStatus | null> {
  let credentials;

  try {
    credentials = await railwayClientForUser({ userId, retry: "none" }).credentials();
  } catch {
    // The credential read itself failed: unverified, not failed. A null
    // keeps the loop live where a thrown error would fail the gather.
    return null;
  }

  for (const credential of credentials) {
    let deployments;

    try {
      ({ deployments } = await credential.listDeployments({
        projectId: target.projectId,
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        limit: 1,
      }));
    } catch {
      continue;
    }

    const [latest] = deployments;

    // No deployments: nothing observed — not a success, not a failure.
    if (!latest) return null;

    const status = collapseRailwayStatus(latest.status);

    // Unknown token: the provider spoke a state this build does not name.
    if (!status) return null;

    return {
      status,
      deploymentId: latest.id,
      providerEventTime: parseProviderInstant(latest.createdAt),
      url: latest.url,
    };
  }

  return null;
}

/**
 * Collapse a Railway deployment status into the registry's outcome
 * vocabulary. Byte-exact on the provider enum: anything unlisted — a future
 * status, a casing drift — reads as unknown, and absence never closes.
 */
function collapseRailwayStatus(status: string): "success" | "failure" | "pending" | null {
  switch (status) {
    case "SUCCESS":
      return "success";
    case "FAILED":
    case "CRASHED":
      return "failure";
    case "BUILDING":
    case "DEPLOYING":
    case "QUEUED":
    case "PENDING":
    case "INITIALIZING":
    case "WAITING":
      return "pending";
    default:
      return null;
  }
}

function parseProviderInstant(value: string | null): Date | null {
  if (!value) return null;

  const time = new Date(value);

  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * A minted pull receipt: the structured body `reduceRailwayEvent` folds.
 * Named (not anonymous) so the mint's return type keeps its evidence.
 */
export interface RailwayPullReceipt {
  eventType: typeof RAILWAY_PULL_EVENT_TYPE;
  payload: unknown;
}

/**
 * Mint the pull receipt body for a parsed status — the ONLY constructor of
 * the shape `reduceRailwayEvent` folds. Takes `ParsedRailwayStatus`, never
 * text: an email string or adapter output cannot construct it, because no
 * string-taking overload exists (criterion 6).
 */
export function mintRailwayPullReceipt(
  target: RailwayPullTarget,
  parsed: ParsedRailwayStatus,
): RailwayPullReceipt {
  return {
    eventType: RAILWAY_PULL_EVENT_TYPE,
    payload: {
      target: {
        projectId: target.projectId,
        serviceId: target.serviceId,
        environmentId: target.environmentId,
      },
      deployment: {
        id: parsed.deploymentId,
        status: parsed.status,
        createdAt: parsed.providerEventTime?.toISOString() ?? null,
        url: parsed.url,
      },
    },
  };
}

/** One pulled target's verdict for the gather step. */
export interface RailwayPullResult {
  target: RailwayPullTarget;
  targetId: string;
  names: RailwayTargetNames | null;
  /** The read's outcome, or null when the read failed, timed out, or puzzled. */
  status: ParsedRailwayStatus["status"] | null;
  /**
   * `applied` — the read folded (a later success closes, a later failure
   * reopens, per the target kind's policy). `duplicate` — the row already
   * holds this outcome, so byte-identical repeats collapse and mint nothing.
   * `unverified` — the read proved nothing; the loop stays live.
   */
  outcome: "applied" | "duplicate" | "unverified";
  deploymentId: string | null;
  url: string | null;
  occurredAt: string | null;
}

const MAX_RAILWAY_PULL_TARGETS = 5;

/**
 * Pull current state for each target and fold it. The dedup is structural:
 * when the target row already holds the outcome this read proved, nothing is
 * minted — so redeliveries, retries, and identical consecutive reads cannot
 * move the row. When the outcome differs, the store's own recency rule
 * decides (a stale read loses to the row), never this function.
 */
export async function pullRailwayTargets(
  userId: string,
  targets: readonly RailwayPullTarget[],
): Promise<RailwayPullResult[]> {
  const names = await resolveRailwayTargetNames(userId).catch(
    () => new Map<string, RailwayTargetNames>(),
  );

  const results: RailwayPullResult[] = [];

  for (const target of targets.slice(0, MAX_RAILWAY_PULL_TARGETS)) {
    const targetId = canonicalizeRailwayTargetId(target);

    if (!targetId) {
      results.push({
        target,
        targetId: "",
        names: null,
        status: null,
        outcome: "unverified",
        deploymentId: null,
        url: null,
        occurredAt: null,
      });
      continue;
    }

    const parsed = await readRailwayDeploymentStatus(userId, target);

    if (!parsed) {
      results.push({
        target,
        targetId,
        names: names.get(targetId) ?? null,
        status: null,
        outcome: "unverified",
        deploymentId: null,
        url: null,
        occurredAt: null,
      });
      continue;
    }

    const result: RailwayPullResult = {
      target,
      targetId,
      names: names.get(targetId) ?? null,
      status: parsed.status,
      outcome: "applied",
      deploymentId: parsed.deploymentId,
      url: parsed.url,
      occurredAt: parsed.providerEventTime?.toISOString() ?? null,
    };

    const existing = await objectStateStore.getByIdentity(userId, {
      provider: "railway",
      kind: "deployment_target",
      externalId: targetId,
    });

    if (existing && existing.nativeState === parsed.status) {
      result.outcome = "duplicate";
      results.push(result);
      continue;
    }

    const receipt = mintRailwayPullReceipt(target, parsed);

    await objectStateStore.applyEvent({
      userId,
      provider: "railway",
      eventType: receipt.eventType,
      action: null,
      payload: receipt.payload,
      deliveredAt: new Date(),
    });

    results.push(result);
  }

  return results;
}

/**
 * Best-effort display names for known targets, keyed by canonical target id.
 * One `listProjects` per credential; anything fails → empty map, and titles
 * fall back to ids. Names are display only and never identity.
 */
async function resolveRailwayTargetNames(userId: string): Promise<Map<string, RailwayTargetNames>> {
  const byId = new Map<string, RailwayTargetNames>();
  const credentials = await railwayClientForUser({ userId, retry: "none" }).credentials();

  for (const credential of credentials) {
    const { projects } = await credential.listProjects();

    for (const project of projects) {
      for (const service of project.services) {
        for (const environment of project.environments) {
          const targetId = canonicalizeRailwayTargetId({
            projectId: project.id,
            serviceId: service.id,
            environmentId: environment.id,
          });

          if (targetId && !byId.has(targetId)) {
            byId.set(targetId, {
              project: project.name,
              service: service.name,
              environment: environment.name,
            });
          }
        }
      }
    }
  }

  return byId;
}

/**
 * Discover pull targets from the provider's own project list — the
 * bootstrap, before any target row exists. Bounded: the first
 * `MAX_RAILWAY_PULL_TARGETS` in provider order. A transport fault discovers
 * nothing, so the loop stays live rather than closing on an empty list.
 */
export async function discoverRailwayTargets(userId: string): Promise<RailwayPullTarget[]> {
  let credentials;

  try {
    credentials = await railwayClientForUser({ userId, retry: "none" }).credentials();
  } catch {
    return [];
  }

  const targets: RailwayPullTarget[] = [];

  for (const credential of credentials) {
    let projects;

    try {
      ({ projects } = await credential.listProjects());
    } catch {
      continue;
    }

    for (const project of projects) {
      for (const service of project.services) {
        for (const environment of project.environments) {
          if (targets.length >= MAX_RAILWAY_PULL_TARGETS) return targets;

          targets.push({
            projectId: project.id,
            serviceId: service.id,
            environmentId: environment.id,
          });
        }
      }
    }
  }

  return targets;
}

/**
 * The Railway MCP connection's readiness as pull provenance: connected means
 * the stored row is `ready`, and issuer-pinned means its authorization server
 * is byte-for-byte `RAILWAY_MCP_ISSUER` — never URL-round-tripped. v1's read
 * travels over the native token, so this gates nothing yet; it is the
 * precondition the MCP transport upgrade will require, recorded now.
 */
export async function readRailwayMcpReadiness(
  userId: string,
): Promise<{ connected: boolean; issuerPinned: boolean }> {
  const connections = await listOwnedConnections(userId);

  const railway = connections.find(
    (connection) => builtInProviderForEndpoint(connection.server.endpointUrl) === "railway",
  );

  if (!railway) return { connected: false, issuerPinned: false };

  return {
    connected: railway.status === "ready",
    issuerPinned: railway.authServerIdentity === RAILWAY_MCP_ISSUER,
  };
}

/**
 * A surfaced digest item signaling a Railway deployment failure — the email
 * half of the gather trigger. Deliberately narrow (a railway sender domain
 * AND a failure word in subject or snippet) and trigger-only: it causes a
 * verified read, never an assertion. The structured follow-up is a Railway
 * deployment-URL grammar plus a text adapter; until then this heuristic is
 * the only way a brand-new failure (no target row yet, discovery already
 * bootstrapped) starts a pull.
 */
export function digestSignalsRailwayFailure(
  items: readonly { subject?: string | null; from?: string | null; snippet?: string | null }[],
): boolean {
  return items.some((item) => {
    const from = item.from ?? "";

    if (!/railway\.(app|com)/i.test(from)) return false;

    return /fail|error|crash|timed out|unable to deploy/i.test(
      `${item.subject ?? ""} ${item.snippet ?? ""}`,
    );
  });
}

/** Phrase one pull result as a briefing activity item — red-then-green lives here. */
export function railwayPullResultToActivityItem(
  result: RailwayPullResult,
): IntegrationActivityItem {
  const where = result.names
    ? `${result.names.service} (${result.names.environment})`
    : result.targetId || "unknown target";

  const word =
    result.status === "success"
      ? "succeeded"
      : result.status === "failure"
        ? "failed"
        : result.status === "pending"
          ? "building"
          : "unverified";

  return {
    id: `railway-pull:${result.targetId || "unknown"}:${result.deploymentId ?? "unverified"}`,
    provider: "railway",
    source: "direct_api",
    activityCategory: "deploy",
    providerKind: "railway.deployment_status",
    title: `Railway deployment ${word}: ${where}`,
    status:
      result.status === "success"
        ? "succeeded"
        : result.status === "failure"
          ? "failed"
          : result.status === "pending"
            ? "open"
            : "needs_attention",
    severity: result.status === "failure" ? "warning" : "info",
    occurredAt: result.occurredAt ?? new Date().toISOString(),
    ...(result.url && result.url.startsWith("https://") ? { url: result.url } : {}),
  };
}

/**
 * The gather-time hook: a surfaced deployment failure triggers a live status
 * read, and the read's verdicts return as deployment activity lines. Runs
 * after the email digest resolves (it needs the surfaced items) and before
 * the gather result assembles.
 *
 * Trigger, in order: failed target rows (the loop is live — re-verify),
 * active target rows (a pull is in flight — follow it to its outcome),
 * zero target rows (bootstrap from the provider's own project list), or a
 * Railway failure mail over rows that all read resolved (the failure is new
 * — re-verify). All-resolved rows with no mail: quiet, no pull.
 *
 * Never throws: any fault — no credential, no transport, no rows, a DB
 * blip — resolves to no lines, and every loop stays live. A failed read is
 * an absence, never evidence (ADR-0048-D).
 */
export async function gatherRailwayVerifiedPull(args: {
  userId: string;
  digestItems: readonly {
    subject?: string | null;
    from?: string | null;
    snippet?: string | null;
  }[];
}): Promise<IntegrationActivityItem[]> {
  try {
    const failed = await objectStateStore.list(args.userId, "railway", {
      kind: "deployment_target",
      stateCategory: "failed",
      limit: MAX_RAILWAY_PULL_TARGETS,
    });

    const active =
      failed.length < MAX_RAILWAY_PULL_TARGETS
        ? await objectStateStore.list(args.userId, "railway", {
            kind: "deployment_target",
            stateCategory: "active",
            limit: MAX_RAILWAY_PULL_TARGETS - failed.length,
          })
        : [];

    let targets = rowsToPullTargets([...failed, ...active]);

    if (targets.length === 0) {
      const known = await objectStateStore.list(args.userId, "railway", {
        kind: "deployment_target",
        limit: MAX_RAILWAY_PULL_TARGETS,
      });

      if (known.length === 0) {
        targets = await discoverRailwayTargets(args.userId);
      } else if (digestSignalsRailwayFailure(args.digestItems)) {
        targets = rowsToPullTargets(known);
      } else {
        return [];
      }
    }

    if (targets.length === 0) return [];

    const results = await pullRailwayTargets(args.userId, targets);

    return results.map(railwayPullResultToActivityItem);
  } catch {
    return [];
  }
}

/**
 * Read pull targets back off stored rows. The external id IS the canonical
 * `projectId/serviceId/environmentId` form (the reducer only writes what
 * `canonicalizeRailwayTargetId` returned, which refuses slashes), so a
 * three-part split recovers the query the pull needs. Anything else is a row
 * this build did not write — dropped, never pulled.
 */
function rowsToPullTargets(rows: readonly ObjectState[]): RailwayPullTarget[] {
  const targets: RailwayPullTarget[] = [];

  for (const row of rows) {
    const [projectId, serviceId, environmentId] = row.externalId.split("/");

    if (projectId && serviceId && environmentId) {
      targets.push({ projectId, serviceId, environmentId });
    }
  }

  return targets;
}
