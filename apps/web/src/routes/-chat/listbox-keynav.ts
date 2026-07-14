import type { KeyboardEvent } from "react";

/**
 * Roving arrow-key navigation for a Radix Popover styled as a `role="listbox"`
 * of `role="option"` buttons (the model-tier + artifact pickers). Radix Popover
 * only wires Tab traversal and Escape; a listbox contract implies Up/Down/Home/
 * End move focus between the options, so a screen reader that announces
 * "listbox" gets the interaction it promises. Attach to `Popover.Content`'s
 * `onKeyDown` — non-navigation keys fall through untouched (Escape still
 * closes, Tab still traverses).
 */
export function handleListboxKeyDown(event: KeyboardEvent<HTMLElement>) {
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;

  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])'),
  );
  if (options.length === 0) return;

  event.preventDefault();
  const active = document.activeElement;
  const current = active instanceof HTMLElement ? options.indexOf(active) : -1;

  let next: number;
  if (key === "Home") next = 0;
  else if (key === "End") next = options.length - 1;
  else if (key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % options.length;
  else next = current <= 0 ? options.length - 1 : current - 1;

  options[next]?.focus();
}
