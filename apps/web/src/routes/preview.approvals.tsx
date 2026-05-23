import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  CalendarPlus,
  Check,
  ClipboardCheck,
  Mail,
  Pencil,
  Workflow,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { VsButton, VsCard, VsPill, VsTextarea } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /approvals.
 *
 * The dimension version subscribes to a Replicache prefix and posts
 * decisions back through Eden. This preview lives on fixture data so
 * the gating UX can be reviewed end-to-end (input JSON editor, reason
 * box, 4 decision buttons) without the auth/eden plumbing. Buttons are
 * stateful no-ops that remove the card from the local list.
 */
export const Route = createFileRoute("/preview/approvals")({
  component: PreviewApprovalsPage,
});

type RiskTier = "low" | "medium" | "high";
type ToolName = "gmail.send_draft" | "calendar.create_event";

interface LocalApproval {
  id: string;
  toolName: ToolName;
  workflowSlug: string;
  runId: string;
  integration: string;
  riskTier: RiskTier;
  proposedInput: Record<string, unknown>;
  recentRejection?: { decidedAt: string; reason: string };
  createdAt: string;
}

const SEED_APPROVALS: LocalApproval[] = [
  {
    id: "stg_01",
    toolName: "gmail.send_draft",
    workflowSlug: "morning-briefing",
    runId: "run_8f3c2a17be4d",
    integration: "Gmail",
    riskTier: "high",
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    recentRejection: {
      decidedAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
      reason: "Tone was too casual — tighten before resending.",
    },
    proposedInput: {
      to: ["maya@sycamore.vc"],
      cc: [],
      subject: "Re: vesting cliff",
      threadId: "thr_9120af",
      bodyText:
        "Hi Maya — the 4-year cliff is on Aug 14. Happy to pull the cap-table snapshot tonight if useful. — Y",
    },
  },
  {
    id: "stg_02",
    toolName: "calendar.create_event",
    workflowSlug: "morning-briefing",
    runId: "run_8f3c2a17be4d",
    integration: "Google Calendar",
    riskTier: "medium",
    createdAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    proposedInput: {
      summary: "Focus block — Sycamore recap",
      start: "2026-05-24T14:00:00+05:30",
      end: "2026-05-24T15:30:00+05:30",
      attendees: [],
      description: "Pulled from morning briefing — keep phone on silent.",
    },
  },
];

function PreviewApprovalsPage() {
  const [approvals, setApprovals] = useState<LocalApproval[]>(SEED_APPROVALS);

  const sorted = useMemo(
    () => approvals.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [approvals],
  );

  const removeApproval = (id: string) =>
    setApprovals((prev) => prev.filter((a) => a.id !== id));

  return (
    <ApprovalsShell count={sorted.length}>
      {sorted.length === 0 ? (
        <VsCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <span
            className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
            aria-hidden
          >
            <ClipboardCheck size={18} />
          </span>
          <p className="text-sm font-medium text-vs-fg-4">No pending approvals</p>
          <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
            Alfred will pause here when a workflow reaches a gated action.
          </p>
        </VsCard>
      ) : (
        <div className="flex flex-col gap-3">
          {sorted.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onResolve={() => removeApproval(approval.id)}
            />
          ))}
        </div>
      )}
    </ApprovalsShell>
  );
}

function ApprovalsShell({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <header className="mb-9 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[36px] leading-[42px] font-medium tracking-tight text-vs-fg-4">
              Approvals
            </h1>
            <p className="mt-2 text-sm text-vs-fg-3">
              Gated workflow actions waiting for review.
            </p>
          </div>
          <VsPill tone={count > 0 ? "amber" : undefined}>{count} pending</VsPill>
        </header>

        {children}
      </main>
    </div>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: LocalApproval;
  onResolve: () => void;
}) {
  const [draftText, setDraftText] = useState(() => formatJson(approval.proposedInput));
  const [reason, setReason] = useState("");

  const draft = useMemo(() => parseJson(draftText), [draftText]);
  const reasonRequired = reason.trim().length === 0;

  return (
    <VsCard className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ToolIcon toolName={approval.toolName} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-medium text-vs-fg-4">
                {approval.toolName}
              </h2>
              <RiskPill riskTier={approval.riskTier} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-vs-fg-3">
              <Link
                to="/preview/workflows/$workflow"
                params={{ workflow: approval.workflowSlug }}
                className={cn(
                  "inline-flex items-center gap-1 rounded transition-colors hover:text-vs-fg-4",
                  "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
                )}
              >
                <Workflow size={12} />
                {approval.workflowSlug}
              </Link>
              <span className="text-vs-fg-2">·</span>
              <span className="font-mono">{shortId(approval.runId)}</span>
              <span className="text-vs-fg-2">·</span>
              <span>{formatTimestamp(approval.createdAt)}</span>
            </div>
          </div>
        </div>
        <VsPill tone="sky">{approval.integration}</VsPill>
      </div>

      {approval.recentRejection ? (
        <div className="flex items-start gap-2 rounded-xl bg-vs-amber-1 px-3 py-2.5 text-xs leading-5 text-vs-amber-4 shadow-[0_0_0_1px_var(--vs-amber-2)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              Last {approval.toolName} rejection was{" "}
              {formatTimestamp(approval.recentRejection.decidedAt)}
            </p>
            <p className="mt-0.5 break-words opacity-80">{approval.recentRejection.reason}</p>
          </div>
        </div>
      ) : null}

      <InputPreview toolName={approval.toolName} input={approval.proposedInput} />

      <div>
        <label
          htmlFor={`vs-approval-input-${approval.id}`}
          className="text-xs font-medium text-vs-fg-3"
        >
          Input JSON
        </label>
        <VsTextarea
          id={`vs-approval-input-${approval.id}`}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          spellCheck={false}
          className={cn(
            "mt-2 min-h-[180px] font-mono text-[12px] leading-5",
            !draft.ok && "focus-visible:ring-vs-red-2",
          )}
        />
        {!draft.ok ? (
          <p className="mt-2 text-[12px] text-vs-red-4">{draft.message}</p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor={`vs-approval-reason-${approval.id}`}
          className="text-xs font-medium text-vs-fg-3"
        >
          Rejection reason
        </label>
        <VsTextarea
          id={`vs-approval-reason-${approval.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="mt-2 min-h-[72px]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <VsButton
          variant="primary"
          size="md"
          leading={<Check size={14} />}
          onClick={onResolve}
        >
          Approve
        </VsButton>
        <VsButton
          variant="white"
          size="md"
          leading={<Pencil size={14} />}
          disabled={!draft.ok}
          onClick={onResolve}
        >
          Approve with edits
        </VsButton>
        <VsButton
          variant="ghost"
          size="md"
          leading={<XCircle size={14} />}
          disabled={reasonRequired}
          onClick={onResolve}
        >
          Reject
        </VsButton>
        <VsButton
          variant="destructive"
          size="md"
          leading={<Ban size={14} />}
          disabled={reasonRequired}
          onClick={onResolve}
        >
          Reject and end run
        </VsButton>
      </div>
    </VsCard>
  );
}

function ToolIcon({ toolName }: { toolName: ToolName }) {
  const Icon: LucideIcon = toolName === "gmail.send_draft" ? Mail : CalendarPlus;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl",
        toolName === "gmail.send_draft" ? "bg-vs-red-1 text-vs-red-4" : "bg-vs-blue-1 text-vs-blue-4",
      )}
    >
      <Icon size={18} />
    </span>
  );
}

function RiskPill({ riskTier }: { riskTier: RiskTier }) {
  const tone = riskTier === "high" ? "red" : riskTier === "medium" ? "amber" : "green";
  return <VsPill tone={tone}>{riskTier}</VsPill>;
}

function InputPreview({
  toolName,
  input,
}: {
  toolName: ToolName;
  input: Record<string, unknown>;
}) {
  if (toolName === "gmail.send_draft") {
    return (
      <PreviewGrid>
        <PreviewField label="To" value={stringArray(input.to).join(", ")} />
        <PreviewField label="Cc" value={stringArray(input.cc).join(", ")} />
        <PreviewField label="Subject" value={stringValue(input.subject)} />
        <PreviewField label="Thread" value={stringValue(input.threadId)} />
        <PreviewField label="Body" value={stringValue(input.bodyText)} multiline />
      </PreviewGrid>
    );
  }
  return (
    <PreviewGrid>
      <PreviewField label="Summary" value={stringValue(input.summary)} />
      <PreviewField label="Start" value={stringValue(input.start)} />
      <PreviewField label="End" value={stringValue(input.end)} />
      <PreviewField label="Attendees" value={stringArray(input.attendees).join(", ")} />
      <PreviewField label="Description" value={stringValue(input.description)} multiline />
    </PreviewGrid>
  );
}

function PreviewGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-2 rounded-xl bg-vs-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
      {children}
    </div>
  );
}

function PreviewField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const display = value.trim() || "—";
  return (
    <div className={cn(multiline && "sm:col-span-2")}>
      <p className="text-[11px] font-medium uppercase tracking-tight text-vs-fg-2">{label}</p>
      <p
        className={cn(
          "mt-1 break-words text-xs leading-5 text-vs-fg-4",
          multiline && "max-h-40 overflow-auto whitespace-pre-wrap",
        )}
      >
        {display}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */

type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 10)}…` : value;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `today at ${d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
