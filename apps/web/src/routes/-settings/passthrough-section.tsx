import { SUPPORTED_PASSTHROUGH_SLUGS, type SupportedIntegrationSlug } from "@alfred/contracts";
import {
  AlertCircle,
  CalendarDays,
  FileText,
  GitBranch,
  HardDrive,
  Mail,
  NotebookText,
  Presentation,
  RefreshCw,
  Table2,
  TrainFront,
  Triangle,
  type LucideIcon,
} from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { usePassthroughFlags } from "~/lib/replicache/use-passthrough-flags";
import type { AppTint } from "~/lib/tints";
import { AgentRow } from "./agent-row";
import type { BackgroundAgentDef } from "./helpers";

const RETRY_LEADING = <RefreshCw size={13} aria-hidden />;

interface PassthroughMeta {
  label: string;
  helper: string;
  icon: LucideIcon;
  tint: AppTint;
}

// Presentation only. The row LIST is driven by SUPPORTED_PASSTHROUGH_SLUGS
// (contracts) so a newly-supported integration can't ship without a toggle;
// this exhaustive Record forces it to also declare how it renders.
const PASSTHROUGH_META: Record<SupportedIntegrationSlug, PassthroughMeta> = {
  gmail: {
    label: "Gmail",
    helper:
      "Raw read-only Gmail API — list labels, read message metadata beyond the curated tools.",
    icon: Mail,
    tint: "green",
  },
  calendar: {
    label: "Calendar",
    helper:
      "Raw read-only Calendar API — calendar lists, settings, and event fields we never modeled.",
    icon: CalendarDays,
    tint: "sky",
  },
  drive: {
    label: "Drive",
    helper: "Raw read-only Drive API — file metadata, permissions, and revisions.",
    icon: HardDrive,
    tint: "amber",
  },
  docs: {
    label: "Docs",
    helper:
      "Raw read-only Docs API — document structure and metadata (content stays in the curated tools).",
    icon: FileText,
    tint: "sky",
  },
  sheets: {
    label: "Sheets",
    helper: "Raw read-only Sheets API — spreadsheet structure, named ranges, and metadata.",
    icon: Table2,
    tint: "green",
  },
  slides: {
    label: "Slides",
    helper: "Raw read-only Slides API — presentation structure and metadata.",
    icon: Presentation,
    tint: "orange",
  },
  github: {
    label: "GitHub",
    helper: "Raw read-only GitHub REST — workflow runs, commits, releases, branches, and contents.",
    icon: GitBranch,
    tint: "purple",
  },
  notion: {
    label: "Notion",
    helper: "Raw read-only Notion API — database schema, page properties, and search.",
    icon: NotebookText,
    tint: "pink",
  },
  railway: {
    label: "Railway",
    helper: "Raw read-only Railway GraphQL — service, deployment, and environment fields.",
    icon: TrainFront,
    tint: "purple",
  },
  vercel: {
    label: "Vercel",
    helper: "Raw read-only Vercel REST — project and deployment detail.",
    icon: Triangle,
    tint: "amber",
  },
};

/**
 * General read-only API access toggles (ADR-0074 rung-a). One switch per
 * supported integration for the raw passthrough tool the boss uses to reach the
 * long tail the curated tools don't cover. **Default OFF** — a security-
 * sensitive read tier stays dark until you enable it, and stays killable per
 * integration without a deploy. Rendered from SUPPORTED_PASSTHROUGH_SLUGS so it
 * can never drift from the backend's supported set.
 */
export function PassthroughSection() {
  const { isOn, setEnabled, error, retry } = usePassthroughFlags();

  return (
    <AppCard padded={false}>
      <div className="space-y-1 p-5 pb-2">
        <p className="text-sm font-medium text-app-fg-4">General API access</p>
        <p className="text-xs text-app-fg-3">
          Let Alfred issue raw, read-only API calls to reach fields the built-in tools don't cover.
          Off by default; writes are always blocked at the boundary.
        </p>
      </div>
      {error ? (
        <div
          className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
          role="alert"
        >
          <div className="flex min-w-0 gap-2.5">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-app-red-4" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-app-fg-4">Toggles unavailable</p>
              <p className="mt-1 text-xs leading-5 text-app-fg-3">{error}</p>
            </div>
          </div>
          <AppButton
            size="sm"
            variant="ghost"
            leading={RETRY_LEADING}
            onClick={retry}
            className="shrink-0"
          >
            Retry
          </AppButton>
        </div>
      ) : (
        <div className="divide-y divide-app-bg-2">
          {SUPPORTED_PASSTHROUGH_SLUGS.map((slug) => {
            const meta = PASSTHROUGH_META[slug];
            const agent: BackgroundAgentDef = {
              id: `passthrough-${slug}`,
              label: meta.label,
              helper: meta.helper,
              icon: meta.icon,
              tint: meta.tint,
            };
            return (
              <AgentRow
                key={slug}
                agent={agent}
                checked={isOn(slug)}
                onChange={(next) => {
                  // Fire-and-forget optimistic write, matching the sibling
                  // background-agent toggle: Replicache applies locally and
                  // rebases on the next pull; a load failure surfaces via `error`.
                  void setEnabled(slug, next);
                }}
              />
            );
          })}
        </div>
      )}
    </AppCard>
  );
}
