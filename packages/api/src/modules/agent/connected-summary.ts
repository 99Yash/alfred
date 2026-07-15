import type { LoadableIntegrationSlug } from "@alfred/contracts";
import {
  availableToolNames,
  readIntegrationAvailability,
  type IntegrationAvailabilitySnapshot,
  type ToolAvailabilityContext,
} from "../integrations/availability";
import { listRegisteredTools } from "../tools/registry";

/**
 * ADR-0053 connected summary: a frozen, human-readable one-line-per-integration
 * grounding block ("integration.action names — short desc", with `(needs reauth)` markers)
 * snapshotted into `agent_runs.state` at run start and concatenated into the
 * boss/chat/sub-agent system prompt. It is *grounding*, not the security floor:
 * the dispatcher still hard-enforces `allowed_integrations` + connection health
 * before any tool executes. Its job here is to tell the model — in the exact
 * fully-qualified `integration.action` tool names it can paste verbatim — which
 * services are actually live, so the boss stops inventing tools, mis-shaping a
 * call as a bare slug, or asking the user to load an integration it is already
 * connected to.
 *
 * Computed once per run (one DB read) and cached in run state; never recomputed
 * mid-turn, so the system-prompt prefix stays cache-stable (ADR-0053 / ADR-0026).
 */

interface SummarySlug {
  slug: LoadableIntegrationSlug;
  /** Short, user-facing description of what the slug reaches. */
  blurb: string;
  /**
   * When true, append the connected account's identity (e.g. GitHub login) to
   * the catalog line — the F2 binding (ADR-0071). It lets the boss resolve
   * `author:@me` / `owner` from its own connection instead of asking the user.
   * Scoped to GitHub today: that is the connection whose missing identity made
   * the boss ask "which repo?" on a self-referential question.
   */
  showIdentity?: boolean;
}

/**
 * Ordered for stable, readable output. Empty-action stubs (`slack`, `linear`,
 * `imessage`) are intentionally omitted — ADR-0053 skips empty-action slugs.
 */
const SUMMARY_SLUGS: readonly SummarySlug[] = [
  {
    slug: "gmail",
    blurb: "the user's email",
  },
  {
    slug: "calendar",
    blurb: "the user's calendar",
  },
  {
    slug: "drive",
    blurb: "the user's Drive files",
  },
  { slug: "docs", blurb: "the user's Google Docs" },
  {
    slug: "sheets",
    blurb: "the user's spreadsheets",
  },
  {
    slug: "slides",
    blurb: "the user's presentations",
  },
  {
    slug: "github",
    blurb: "the user's GitHub issues and pull requests",
    showIdentity: true,
  },
  // Bearer-token providers (Notion OAuth, Railway API token, Vercel OAuth).
  {
    slug: "notion",
    blurb: "the user's Notion pages and databases",
  },
  {
    slug: "railway",
    blurb: "the user's Railway projects, deployments, and logs",
  },
  {
    slug: "vercel",
    blurb: "the user's Vercel projects and deployments",
  },
];

const CONNECTED_HEADER =
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.";

const NO_INTEGRATIONS_TEXT =
  "You have no integrations connected right now. If the user asks about their email, calendar, files, or other connected data, tell them they need to connect it first — never pretend to have access you do not.";

/**
 * Build the connected summary for `userId`, bounded to `allowedIntegrations`
 * (empty = unrestricted among connected loadable integrations, per ADR-0053).
 * One DB read; call it once at run start and cache the result in run state.
 */
export async function buildConnectedSummary(
  userId: string,
  allowedIntegrations: readonly string[],
): Promise<string> {
  const availability = await readIntegrationAvailability(userId);
  return buildConnectedSummaryFromAvailability(availability, allowedIntegrations, {
    caller: "boss",
    hasThread: true,
  });
}

export function buildConnectedSummaryFromAvailability(
  availability: IntegrationAvailabilitySnapshot,
  allowedIntegrations: readonly string[],
  context: ToolAvailabilityContext,
): string {
  const registeredTools = listRegisteredTools();
  const availableTools = availableToolNames(
    availability,
    registeredTools,
    allowedIntegrations,
    context,
  );
  const allowed = new Set(allowedIntegrations);
  const lines: string[] = [];
  for (const spec of SUMMARY_SLUGS) {
    if (allowed.size > 0 && !allowed.has(spec.slug)) continue;
    const access = availability.integrations.get(spec.slug);
    if (!access || access.health === null) continue;
    // List the fully-qualified tool names (`calendar.list_events`), not the
    // bare actions. A slug-then-actions shape ("calendar — list_events, …")
    // reads like "call `calendar` with action=list_events", and the boss did
    // exactly that — emitting a bare `calendar {action:"list_events"}` call
    // that dispatch can only reject ("Couldn't" card). Handing it the literal
    // `integration.action` strings is the shape it should paste verbatim.
    const identity = spec.showIdentity ? access.accountLabel : null;
    const binding = identity ? ` — connected as ${identity}` : "";
    const tools = registeredTools
      .filter((tool) => tool.integration === spec.slug && availableTools.has(tool.name))
      .map((tool) => tool.name)
      .sort();
    // A slug with credentials but no executable tools needs reauthorization.
    // Exact tool availability wins when a narrower scope still supports part
    // of the integration (for example Gmail read without Gmail send).
    if (tools.length === 0 && access.health === "needs_reauth") {
      lines.push(
        `- ${spec.slug} — ${spec.blurb}${binding} (needs reauth — tell the user to reconnect ${spec.slug}; don't call its tools yet)`,
      );
      continue;
    }
    if (tools.length > 0) lines.push(`- ${tools.join(", ")} — ${spec.blurb}${binding}`);
  }

  if (lines.length === 0) return NO_INTEGRATIONS_TEXT;
  return [CONNECTED_HEADER, ...lines].join("\n");
}
