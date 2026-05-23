import { CalendarClock, ChevronDown } from "lucide-react";
import type { WorkflowDefinition } from "~/lib/workflows";
import { FauxControl } from "./faux-control";

function scheduleTimeLabel(cadence: string): string {
  const match = cadence.match(/\d{1,2}:\d{2}(\s*(?:AM|PM|am|pm))?/);
  return match ? match[0].trim() : "08:00";
}

export function ScheduleBuilder({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-vs-fg-4">
      <span className="text-vs-fg-3">From</span>
      <FauxControl>
        <CalendarClock size={13} className="text-vs-fg-3" />
        <span>Starting date</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
      <span className="text-vs-fg-3">run</span>
      <FauxControl>
        <span>every</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
      <FauxControl className="w-12 justify-center">
        <span>1</span>
      </FauxControl>
      <FauxControl>
        <span>day</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
      <span className="text-vs-fg-3">at</span>
      <FauxControl>
        <span>{scheduleTimeLabel(workflow.cadence)}</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
    </div>
  );
}
