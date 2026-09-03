import {
  LIVE_PROVIDERS,
  type IntegrationAvailabilitySnapshot,
  type ToolRunContext,
} from "@alfred/contracts";
import { availableToolNamesByIntegration } from "@alfred/assistant/tool-runtime";

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

const CONNECTED_HEADER =
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.";

const NO_INTEGRATIONS_TEXT =
  "You have no integrations connected right now. If the user asks about their email, calendar, files, or other connected data, tell them they need to connect it first — never pretend to have access you do not.";

/**
 * The lines iterate `LIVE_PROVIDERS` in registry order (ADR-0093): each live
 * entry carries its `summaryBlurb`, and `identityInSummary` marks the entries
 * whose connected account identity (e.g. GitHub login) is appended — the F2
 * binding (ADR-0071) that lets the boss resolve `author:@me` / `owner` from its
 * own connection instead of asking the user. Planned providers and channels
 * (`slack`, `linear`, `imessage`) are not live entries, so ADR-0053's "skip
 * empty-action slugs" falls out of the type instead of a hand-kept list.
 */
export function buildConnectedSummaryFromAvailability(
  availability: IntegrationAvailabilitySnapshot,
  allowedIntegrations: readonly string[],
  context: ToolRunContext,
): string {
  const availableByIntegration = availableToolNamesByIntegration({
    availability,
    allowedIntegrations,
    context,
  });
  const allowed = new Set(allowedIntegrations);
  const lines: string[] = [];
  for (const entry of LIVE_PROVIDERS) {
    if (allowed.size > 0 && !allowed.has(entry.slug)) continue;
    const access = availability.integrations.get(entry.slug);
    if (!access || access.health === null) continue;
    // List the fully-qualified tool names (`calendar.list_events`), not the
    // bare actions. A slug-then-actions shape ("calendar — list_events, …")
    // reads like "call `calendar` with action=list_events", and the boss did
    // exactly that — emitting a bare `calendar {action:"list_events"}` call
    // that dispatch can only reject ("Couldn't" card). Handing it the literal
    // `integration.action` strings is the shape it should paste verbatim.
    const identity = entry.identityInSummary ? access.accountLabel : null;
    const binding = identity ? ` — connected as ${identity}` : "";
    const tools = availableByIntegration.get(entry.slug) ?? [];
    // A slug with credentials but no executable tools needs reauthorization.
    // Exact tool availability wins when a narrower scope still supports part
    // of the integration (for example Gmail read without Gmail send).
    if (tools.length === 0 && access.health === "needs_reauth") {
      lines.push(
        `- ${entry.slug} — ${entry.summaryBlurb}${binding} (needs reauth — tell the user to reconnect ${entry.slug}; don't call its tools yet)`,
      );
      continue;
    }
    if (tools.length > 0) lines.push(`- ${tools.join(", ")} — ${entry.summaryBlurb}${binding}`);
  }

  if (lines.length === 0) return NO_INTEGRATIONS_TEXT;
  return [CONNECTED_HEADER, ...lines].join("\n");
}
