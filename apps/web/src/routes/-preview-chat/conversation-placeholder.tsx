import { Brain, Sparkles, Users2 } from "lucide-react";
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
    <div className="app-card-in space-y-8">
      <UserTurn text={entry.preview} />
      <AssistantTurn />
      <UserTurn text="Skip the calendar bit — just the email summary, ranked by who's waiting on me." />
      <AssistantTurn followUp />
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="app-card-in flex flex-col items-center justify-center pt-24 text-center">
      <span
        aria-hidden
        className="mb-3 inline-flex size-12 items-center justify-center rounded-full bg-app-purple-1 text-app-purple-4"
      >
        <Sparkles size={18} />
      </span>
      <h2 className="text-base font-medium tracking-tight text-app-fg-4">Ask Alfred anything</h2>
      <p className="mt-1 max-w-sm text-sm text-app-fg-3">
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
          "bg-app-bg-2 text-app-fg-4",
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
        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-app-purple-1 text-app-purple-4"
      >
        <Sparkles size={13} />
      </span>
      <div className="min-w-0 flex-1 space-y-4 text-sm leading-relaxed text-app-fg-3">
        {followUp ? (
          <>
            <RunGroup title="Sorted inbox by who's waiting" itemCount={5}>
              <ThoughtRow duration="2s">
                The user wants just emails ranked by reply urgency, skipping the calendar pull.
              </ThoughtRow>
              <SearchRow
                integration="gmail"
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
              <ToolRow integration="gmail" label="Tagged 3 as Reply today" done />
            </RunGroup>
            <p>
              <span className="font-medium text-app-fg-4">Three to answer.</span> Maya's vesting
              question (waiting 2 days), the Sycamore investor recap (their ask is on the cliff
              date), and a vendor renewal from Linear.
            </p>
            <p>The newsletters and three notifications have been auto-archived to Later.</p>
            <SourcesRow
              items={[
                { integration: "gmail", label: "Inbox", count: 7 },
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
                integration="gmail"
                label="Searched Gmail"
                detail="is:unread newer_than:1d"
                count="8 threads"
              />
              <ToolRow integration="gmail" label="Read 3 threads" detail="Maya, Sycamore, Linear" />
              <ThoughtRow duration="1s">
                Now the calendar: three blocks today plus a tentative.
              </ThoughtRow>
              <SearchRow
                integration="google_calendar"
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
              <span className="font-medium text-app-fg-4">8 unread</span> threads, three of which
              need a reply today. Calendar starts at{" "}
              <span className="font-medium text-app-fg-4">10:00</span> with the eng sync.
            </p>
            <SourcesRow
              items={[
                { integration: "gmail", label: "Inbox", count: 8 },
                { integration: "google_calendar", label: "Calendar", count: 3 },
                { icon: Brain, label: "Memory", count: 2, tone: "pink" },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
