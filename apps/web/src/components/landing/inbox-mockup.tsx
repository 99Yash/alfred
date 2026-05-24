import { Inbox, Pencil } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Hero-grade inbox mockup.
 *
 * Restructured 2026-05-23 to follow dimension's actual Inbox design (live
 * recon while their site was still up). Their version is a **Gmail-style
 * email list** rendered on a white card surface, with each sender shown
 * large alongside an AI-applied auto-label chip (`2: action needed`,
 * `6: fyi`, `10: marketing`, `7: done`) and an explicit `Draft` chip on
 * the rows where the assistant has already prepared a reply. Replaces the
 * earlier "sender tile row + chip ledger" iteration, which read as generic.
 *
 * Vertical rhythm (still aligned with briefing + meeting-prep panels):
 *   1. header ribbon (label + status pill)
 *   2. headline
 *   3. white email-list card (the focal product mockup)
 */
export function InboxMockup({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative isolate h-full overflow-hidden rounded-none ring-0 text-left",
        "morning-briefing-surface",
        className,
      )}
    >
      {/* 1 — Header ribbon */}
      <div className="relative z-10 flex items-center justify-between gap-3 px-8 pt-7">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-medium uppercase tracking-[0.16em] text-white/60">
          <Inbox className="size-3.5 text-white/70" strokeWidth={2.2} />
          Inbox · Today
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-2.5 py-1 text-[11.5px] font-medium text-white/90 ring-1 ring-inset ring-white/20 backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-emerald-300" aria-hidden />
          38 emails · 4 drafted
        </span>
      </div>

      {/* 2 — Headline */}
      <div className="relative z-10 px-8 pt-6">
        <h2
          className={cn(
            "max-w-[28ch] text-balance font-semibold leading-[1.06] tracking-[-0.04em] text-white",
            "text-[28px] sm:text-[32px] lg:text-[34px]",
          )}
        >
          Replies drafted in your tone, ready to send.
        </h2>
      </div>

      {/* 3 — White email-list card (focal mockup) */}
      <EmailListCard />
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Email-list card — white Gmail-style surface holding 5 sender rows.
 * Each row: sender name (left, big), optional Draft chip, AI auto-label
 * (colored), subject preview (right, truncates). Lines divide rows.
 * Sits over the blue Alfred panel surface so it reads as "a real email
 * client embedded in the mockup," matching dimension's white-on-blue
 * inbox section.
 * ------------------------------------------------------------------- */

interface EmailRow {
  sender: string;
  draft?: boolean;
  label: AutoLabel;
  subject: string;
}

type AutoLabel =
  | { kind: "action"; index: number; name: string }
  | { kind: "review"; index: number; name: string }
  | { kind: "fyi"; index: number; name: string }
  | { kind: "marketing"; index: number; name: string }
  | { kind: "done"; index: number; name: string };

const ROWS: ReadonlyArray<EmailRow> = [
  {
    sender: "Anika Sharma",
    draft: true,
    label: { kind: "action", index: 2, name: "action needed" },
    subject: "Re: auth migration — staged today",
  },
  {
    sender: "Dana Chen",
    draft: true,
    label: { kind: "action", index: 2, name: "action needed" },
    subject: "Q3 roadmap thread — needs your take",
  },
  {
    sender: "Marcus Webb",
    draft: true,
    label: { kind: "review", index: 4, name: "review" },
    subject: "Checkout webhook fix — 3 refunds out",
  },
  {
    sender: "Vercel",
    label: { kind: "fyi", index: 6, name: "fyi" },
    subject: "Domain settings updated for alfred.app",
  },
  {
    sender: "Linear",
    label: { kind: "done", index: 9, name: "auto-archived" },
    subject: "Weekly digest from #eng-platform",
  },
];

function EmailListCard() {
  return (
    <div
      className={cn(
        "relative z-10 mx-8 mt-6 mb-8 overflow-hidden rounded-2xl",
        "bg-white shadow-[0_20px_50px_-20px_rgba(15,30,55,0.55)]",
        "ring-1 ring-inset ring-black/5",
      )}
    >
      <ul className="divide-y divide-neutral-200/80">
        {ROWS.map((row) => (
          <EmailListRow key={row.sender} row={row} />
        ))}
      </ul>
    </div>
  );
}

function EmailListRow({ row }: { row: EmailRow }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-neutral-900 sm:text-[16px]">
        {row.sender}
      </span>
      {row.draft ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-700 ring-1 ring-inset ring-neutral-200">
          <Pencil className="size-3" strokeWidth={2.4} />
          Draft
        </span>
      ) : null}
      <AutoLabelChip label={row.label} />
      <span className="hidden min-w-0 flex-[2_2_0] truncate text-[13px] text-neutral-500 sm:inline">
        {row.subject}
      </span>
    </li>
  );
}

/* ----------------------------------------------------------------------
 * Auto-label chip — Gmail-style colored category with a numeric priority
 * prefix, mirroring dimension's `2: action needed`, `6: fyi`, etc.
 * ------------------------------------------------------------------- */

const LABEL_STYLES: Record<AutoLabel["kind"], string> = {
  action: "bg-orange-100 text-orange-800 ring-orange-200/80",
  review: "bg-amber-100 text-amber-800 ring-amber-200/80",
  fyi: "bg-sky-100 text-sky-800 ring-sky-200/80",
  marketing: "bg-pink-100 text-pink-800 ring-pink-200/80",
  done: "bg-emerald-100 text-emerald-800 ring-emerald-200/80",
};

function AutoLabelChip({ label }: { label: AutoLabel }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5",
        "text-[11px] font-semibold ring-1 ring-inset",
        LABEL_STYLES[label.kind],
      )}
    >
      <span className="tabular">{label.index}:</span>
      <span>{label.name}</span>
    </span>
  );
}
