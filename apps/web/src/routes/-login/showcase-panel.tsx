import { Sparkles } from "lucide-react";
import { cn } from "~/lib/utils";
import { BriefRow } from "./brief-row";

export function ShowcasePanel() {
  return (
    <div className="hidden lg:flex relative items-center justify-center overflow-hidden border-l border-vs-bg-a1">
      {/* Quiet ambient wash — pulls the purple accent across the right half */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 60% at 70% 35%, color-mix(in oklch, var(--vs-purple-4) 14%, transparent), transparent 70%)",
        }}
      />

      <div className="relative z-10 max-w-[420px] px-10 py-12 space-y-7">
        <div className="space-y-2">
          <h2 className="text-[26px] font-medium tracking-[-0.04em] text-vs-fg-4 leading-[1.15]">
            Your workday
            <br />
            pulled into focus.
          </h2>
          <p className="text-[13px] text-vs-fg-2">
            Alfred brings your email, calendar, GitHub, and the tools you work in into one place. It
            can prep the meeting, find the blocked pull request, draft the reply in your tone, and
            keep the day moving while you stay focused on the things that actually matter.
          </p>
        </div>

        <div className="relative">
          {/* Stacked card hint — second card peeks from behind */}
          <div
            aria-hidden
            className={cn(
              "absolute inset-x-3 top-3 bottom-[-12px] rounded-2xl bg-vs-bg-1",
              "shadow-[0_1px_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
              "opacity-70",
            )}
          />
          <div
            className={cn(
              "relative rounded-2xl bg-vs-bg-1 p-5 space-y-4",
              "shadow-[0_1px_1px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.05),0_12px_32px_-12px_rgba(0,0,0,0.10)]",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.08em] text-vs-fg-2">
                Friday morning · 8:02
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-vs-purple-1 px-2 py-0.5 text-[10px] font-medium text-vs-purple-4">
                <Sparkles size={10} /> Brief
              </span>
            </div>
            <p className="text-[13px] text-vs-fg-4 leading-relaxed">
              <span className="font-medium">Three things</span> need you today. Pulled from your
              inbox, repos, and calendar.
            </p>
            <ul className="space-y-2 text-[12.5px]">
              <BriefRow
                hue="purple"
                lead="Sycamore"
                body="Term sheet expires Sunday 9pm. Reply drafted. Yours to send."
              />
              <BriefRow
                hue="sky"
                lead="alfred/api #128"
                body="Your review has blocked the release for two days."
              />
              <BriefRow
                hue="amber"
                lead="Design review"
                body="Now Friday 3pm. The agenda's still empty."
              />
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
