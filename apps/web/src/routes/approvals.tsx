import { IDB_KEY, type SyncedActionStaging } from "@alfred/sync";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Ban,
  CalendarPlus,
  Check,
  ClipboardCheck,
  Loader2,
  Mail,
  Pencil,
  Search,
  ShieldAlert,
  Workflow,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import type { ReadTransaction } from "replicache";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { authClient } from "~/lib/auth-client";
import { client, edenErrorMessage } from "~/lib/eden";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import { Pill } from "~/lib/ui";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/approvals")({
  component: ApprovalsPage,
});

const listApprovals = async (tx: ReadTransaction): Promise<SyncedActionStaging[]> => {
  const entries = await tx
    .scan({ prefix: IDB_KEY.ACTION_STAGING({}) })
    .entries()
    .toArray();
  return entries.map(([, v]) => v as unknown as SyncedActionStaging);
};

type ApprovalDecision = "approve" | "reject" | "cancel_run";

type ToolPreview = ComponentType<{ input: unknown }>;

const TOOL_PREVIEWS: Partial<Record<SyncedActionStaging["toolName"], ToolPreview>> = {
  "gmail.search": GmailSearchPreview,
  "gmail.send_draft": GmailSendDraftPreview,
  "calendar.list_events": CalendarListEventsPreview,
  "calendar.create_event": CalendarCreateEventPreview,
};

function ApprovalsPage() {
  const { data: session } = authClient.useSession();
  const approvals = useSubscribe(listApprovals);
  const sorted = useMemo(
    () => (approvals ?? []).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [approvals],
  );

  if (!session?.user) {
    return (
      <ApprovalsShell count={0}>
        <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <span
            className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
            aria-hidden
          >
            <ClipboardCheck size={18} />
          </span>
          <p className="text-sm font-medium text-gray-950">Not signed in</p>
          <p className="text-[12.5px] text-gray-800">Sign in to review pending actions.</p>
          <a
            href="/login"
            className="mt-2 text-[12.5px] text-gray-900 underline underline-offset-4 hover:text-gray-1000"
          >
            Sign in
          </a>
        </Card>
      </ApprovalsShell>
    );
  }

  return (
    <ApprovalsShell count={sorted.length}>
      {approvals === undefined ? (
        <p className="px-1 text-sm text-gray-800">Loading…</p>
      ) : sorted.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <span
            className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
            aria-hidden
          >
            <ClipboardCheck size={18} />
          </span>
          <p className="text-sm font-medium text-gray-950">No pending approvals</p>
          <p className="max-w-[28rem] text-[12.5px] text-gray-800">
            Alfred will pause here when a workflow reaches a gated action.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {sorted.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
        </div>
      )}
    </ApprovalsShell>
  );
}

function ApprovalsShell({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <div className="md:hidden h-6" />

      <header className="mb-9 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="heading-display text-[36px] leading-[42px] font-medium">Approvals</h1>
          <p className="mt-2 text-sm text-gray-800">Gated workflow actions waiting for review.</p>
        </div>
        <Pill tone={count > 0 ? "warning" : "neutral"} className="w-fit">
          {count} pending
        </Pill>
      </header>

      {children}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: SyncedActionStaging }) {
  const rep = useReplicache();
  const [draftText, setDraftText] = useState(() => formatJson(approval.proposedInput));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<ApprovalDecision | "approve_with_edits" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo(() => parseJson(draftText), [draftText]);
  const Preview = TOOL_PREVIEWS[approval.toolName] ?? GenericInputPreview;
  const busy = submitting !== null;

  const decide = async (decision: ApprovalDecision, editedInput?: unknown) => {
    setSubmitting(editedInput === undefined ? decision : "approve_with_edits");
    setError(null);
    try {
      const payload =
        decision === "approve"
          ? editedInput === undefined
            ? { decision }
            : { decision, editedInput }
          : { decision, reason: reason.trim() };
      const res = await client.api.approvals({ stagingId: approval.id }).decision.post(payload);
      if (res.error) {
        setError(edenErrorMessage(res.error, "Failed to submit approval decision"));
        return;
      }
      await rep?.pull();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit approval decision");
    } finally {
      setSubmitting(null);
    }
  };

  const approveWithEdits = async () => {
    if (!draft.ok) return;
    await decide("approve", draft.value);
  };

  return (
    <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-gray-950 sm:p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <ToolIcon toolName={approval.toolName} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-[15px] font-medium text-gray-1000">
                  {approval.toolName}
                </h2>
                <RiskPill riskTier={approval.riskTier} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-gray-750">
                <Link
                  to="/workflows/$workflow"
                  params={{ workflow: approval.workflowSlug }}
                  className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-gray-1000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                >
                  <Workflow size={12} />
                  {approval.workflowSlug}
                </Link>
                <span className="text-gray-600">·</span>
                <span className="font-mono">{shortId(approval.runId)}</span>
                <span className="text-gray-600">·</span>
                <span>{formatTimestamp(approval.createdAt)}</span>
              </div>
            </div>
          </div>
          <Pill tone="info" className="w-fit">
            {approval.integration}
          </Pill>
        </div>

        {approval.recentRejection ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2.5 text-[12.5px] leading-5 text-amber-100">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="font-medium text-amber-200">
                Last {approval.toolName} rejection was{" "}
                {formatTimestamp(approval.recentRejection.decidedAt)}
              </p>
              {approval.recentRejection.reason ? (
                <p className="mt-0.5 break-words text-amber-100/80">
                  {approval.recentRejection.reason}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <Preview input={approval.proposedInput} />

        <div>
          <label
            htmlFor={`approval-input-${approval.id}`}
            className="text-[12px] font-medium text-gray-850"
          >
            Input JSON
          </label>
          <Textarea
            id={`approval-input-${approval.id}`}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            spellCheck={false}
            className={cn(
              "mt-2 min-h-[180px] font-mono text-[12px] leading-5",
              !draft.ok && "border-red-400/40 focus-visible:ring-red-500/40",
            )}
          />
          {!draft.ok ? <p className="mt-2 text-[12px] text-red-300">{draft.message}</p> : null}
        </div>

        <div>
          <label
            htmlFor={`approval-reason-${approval.id}`}
            className="text-[12px] font-medium text-gray-850"
          >
            Rejection reason
          </label>
          <Textarea
            id={`approval-reason-${approval.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="mt-2 min-h-[72px]"
          />
        </div>

        {error ? <p className="text-[12.5px] text-red-300">{error}</p> : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="md"
            variant="primary"
            leading={buttonIcon(submitting, "approve", Check)}
            disabled={busy}
            onClick={() => void decide("approve")}
          >
            Approve
          </Button>
          <Button
            size="md"
            variant="white"
            leading={buttonIcon(submitting, "approve_with_edits", Pencil)}
            disabled={busy || !draft.ok}
            onClick={() => void approveWithEdits()}
          >
            Approve with edits
          </Button>
          <Button
            size="md"
            variant="ghost"
            leading={buttonIcon(submitting, "reject", XCircle)}
            disabled={busy || reason.trim().length === 0}
            onClick={() => void decide("reject")}
          >
            Reject
          </Button>
          <Button
            size="md"
            variant="destructive"
            leading={buttonIcon(submitting, "cancel_run", Ban)}
            disabled={busy || reason.trim().length === 0}
            onClick={() => void decide("cancel_run")}
          >
            Reject and end run
          </Button>
        </div>
      </div>
    </Card>
  );
}

function buttonIcon(
  submitting: ApprovalDecision | "approve_with_edits" | null,
  key: ApprovalDecision | "approve_with_edits",
  Icon: LucideIcon,
) {
  return submitting === key ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />;
}

function ToolIcon({ toolName }: { toolName: SyncedActionStaging["toolName"] }) {
  const Icon =
    toolName === "gmail.search"
      ? Search
      : toolName === "gmail.send_draft"
        ? Mail
        : toolName.startsWith("calendar.")
          ? CalendarPlus
          : ShieldAlert;
  return (
    <span
      aria-hidden
      className="frost-icon-tile grid size-10 shrink-0 place-items-center rounded-xl text-gray-900"
    >
      <Icon size={18} />
    </span>
  );
}

function RiskPill({ riskTier }: { riskTier: SyncedActionStaging["riskTier"] }) {
  const tone = riskTier === "high" ? "negative" : riskTier === "medium" ? "warning" : "positive";
  return <Pill tone={tone}>{formatLabel(riskTier)}</Pill>;
}

function GmailSearchPreview({ input }: { input: unknown }) {
  const record = toRecord(input);
  return (
    <PreviewGrid>
      <PreviewField label="Query" value={stringValue(record.q)} />
      <PreviewField label="Max results" value={stringValue(record.maxResults)} />
    </PreviewGrid>
  );
}

function GmailSendDraftPreview({ input }: { input: unknown }) {
  const record = toRecord(input);
  return (
    <PreviewGrid>
      <PreviewField label="To" value={stringArray(record.to).join(", ")} />
      <PreviewField label="Cc" value={stringArray(record.cc).join(", ")} />
      <PreviewField label="Subject" value={stringValue(record.subject)} />
      <PreviewField label="Thread" value={stringValue(record.threadId)} />
      <PreviewField label="Body" value={stringValue(record.bodyText)} multiline />
    </PreviewGrid>
  );
}

function CalendarListEventsPreview({ input }: { input: unknown }) {
  const record = toRecord(input);
  return (
    <PreviewGrid>
      <PreviewField label="Start" value={stringValue(record.timeMin)} />
      <PreviewField label="End" value={stringValue(record.timeMax)} />
      <PreviewField label="Max results" value={stringValue(record.maxResults)} />
    </PreviewGrid>
  );
}

function CalendarCreateEventPreview({ input }: { input: unknown }) {
  const record = toRecord(input);
  return (
    <PreviewGrid>
      <PreviewField label="Summary" value={stringValue(record.summary)} />
      <PreviewField label="Start" value={stringValue(record.start)} />
      <PreviewField label="End" value={stringValue(record.end)} />
      <PreviewField label="Attendees" value={stringArray(record.attendees).join(", ")} />
      <PreviewField label="Description" value={stringValue(record.description)} multiline />
    </PreviewGrid>
  );
}

function GenericInputPreview({ input }: { input: unknown }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-black/20">
      <pre className="max-h-52 overflow-auto p-3 text-[12px] leading-5 text-gray-850">
        {formatJson(input)}
      </pre>
    </div>
  );
}

function PreviewGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-black/20 p-3 sm:grid-cols-2">
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
      <p className="text-[11px] font-medium uppercase text-gray-700">{label}</p>
      <p
        className={cn(
          "mt-1 break-words text-[12.5px] leading-5 text-gray-950",
          multiline && "max-h-40 overflow-auto whitespace-pre-wrap",
        )}
      >
        {display}
      </p>
    </div>
  );
}

type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Invalid JSON",
    };
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
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
