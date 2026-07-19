import { capitalize } from "~/lib/strings";

export function formatDayHeading(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function slotLabel(slot: string): string {
  return capitalize(slot);
}
