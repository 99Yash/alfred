import { BookOpen, Brain, Calendar, Inbox, Mail, Sparkles, Tag, Users2 } from "lucide-react";
import { cn } from "~/lib/utils";
import type { ThreadEntry } from "./helpers";
import { RunGroup } from "./run-group";
import { SourcesRow } from "./sources-row";
import { ThoughtRow } from "./thought-row";
import { SearchRow, ToolRow } from "./tool-row";

export function ConversationPlaceholder({ entry }: { entry: ThreadEntry | undefined }) {
  if (!entry) {
    return <EmptyConversation />;
  }
  return (
    <div className="space-y-8 vs-card-in">
      <UserTurn text={entry.preview} />
      <AssistantTurn />
      <UserTurn text="Skip the calendar bit — just the email summary, ranked by who's waiting on me." />
      <AssistantTurn followUp />
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col items-center justify-center text-center pt-24 vs-card-in">
      <span
        aria-hidden
        className="size-12 rounded-full inline-flex items-center justify-center bg-vs-purple-1 text-vs-purple-4 mb-3"
      >
        <Sparkles size={18} />
      </span>
      <h2 className="text-base font-medium tracking-tight text-vs-fg-4">Ask Alfred anything</h2>
      <p className="mt-1 max-w-sm text-sm text-vs-fg-3">
        Search your mail, summarize a thread, draft a reply, or kick off a workflow.
      </p>
    </div>
  );
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[80%] rounded-2xl rounded-tr-md px-4 py-2.5 text-sm",
          "bg-vs-bg-2 text-vs-fg-4",
        )}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantTurn({ followUp = false }: { followUp?: boolean }) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 size-7 shrink-0 rounded-full bg-vs-purple-1 text-vs-purple-4 inline-flex items-center justify-center"
      >
        <Sparkles size={13} />
      </span>
      <div className="flex-1 min-w-0 space-y-4 text-sm text-vs-fg-3 leading-relaxed">
        {followUp ? (
          <>
            <RunGroup title="Sorted inbox by who's waiting" itemCount={5}>
              <ThoughtRow duration="2s">
                The user wants just emails ranked by reply urgency, skipping the calendar pull.
              </ThoughtRow>
              <SearchRow
                icon={Mail}
                tone="sky"
                label="Filtered Gmail"
                detail="from:* in:inbox -label:later"
                count="7 threads"
              />
              <ToolRow
                icon={Users2}
                tone="purple"
                label="Resolved senders"
                detail="3 of 7 are recurring contacts"
              />
              <ThoughtRow duration="1s">
                Ranked by latest-reply-from-me age: older threads first.
              </ThoughtRow>
              <ToolRow icon={Tag} tone="green" label="Tagged 3 as Reply today" done />
            </RunGroup>
            <p>
              <span className="text-vs-fg-4 font-medium">Three to answer.</span> Maya's vesting
              question (waiting 2 days), the Sycamore investor recap (their ask is on the cliff
              date), and a vendor renewal from Linear.
            </p>
            <p>The newsletters and three notifications have been auto-archived to Later.</p>
            <SourcesRow
              items={[
                { icon: Inbox, label: "Inbox", count: 7, tone: "sky" },
                { icon: Users2, label: "Contacts", count: 3, tone: "purple" },
              ]}
            />
          </>
        ) : (
          <>
            <RunGroup title="Reviewed your morning" itemCount={6}>
              <ThoughtRow duration="2s">
                Pulling unread Gmail threads since yesterday and Friday's calendar blocks.
              </ThoughtRow>
              <SearchRow
                icon={Mail}
                tone="sky"
                label="Searched Gmail"
                detail="is:unread newer_than:1d"
                count="8 threads"
              />
              <ToolRow
                icon={BookOpen}
                tone="purple"
                label="Read 3 threads"
                detail="Maya, Sycamore, Linear"
              />
              <ThoughtRow duration="1s">
                Now the calendar: three blocks today plus a tentative.
              </ThoughtRow>
              <SearchRow
                icon={Calendar}
                tone="amber"
                label="Listed today's events"
                detail="2026-05-23 · primary calendar"
                count="3 events"
              />
              <ToolRow
                icon={Brain}
                tone="pink"
                label="Recalled context"
                detail="2 memory hits about Sycamore"
                done
              />
            </RunGroup>
            <p>
              Here's your morning. You have{" "}
              <span className="text-vs-fg-4 font-medium">8 unread</span> threads, three of which
              need a reply today. Calendar starts at{" "}
              <span className="text-vs-fg-4 font-medium">10:00</span> with the eng sync.
            </p>
            <SourcesRow
              items={[
                { icon: Inbox, label: "Inbox", count: 8, tone: "sky" },
                { icon: Calendar, label: "Calendar", count: 3, tone: "amber" },
                { icon: Brain, label: "Memory", count: 2, tone: "pink" },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
