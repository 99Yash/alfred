/**
 * App-grammar date-time picker.
 *
 * Replaces the native `<input type="datetime-local">` — same h-9 pill trigger
 * as `AppInput`, opening a popover with a month calendar and styled time
 * controls (hour / minute dropdowns + AM·PM toggle). All custom chrome, no
 * native browser picker. Built on `@radix-ui/react-popover`.
 *
 * Values cross the boundary as ISO strings (what the tool schemas expect) and
 * are presented in the viewer's local timezone, matching `formatDateTime`.
 */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import { AppSegmented } from "./segmented";
import { AppSelect, type AppSelectOption } from "./select";

interface AppDateTimePickerProps {
  id?: string;
  /** ISO 8601 string, or undefined when unset. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const HOUR_OPTIONS: AppSelectOption[] = Array.from({ length: 12 }, (_, i) => {
  const h = i === 0 ? 12 : i;
  return { value: String(h), label: String(h) };
});

export function AppDateTimePicker({
  id,
  value,
  onChange,
  disabled,
  placeholder = "Pick a date & time",
  className,
}: AppDateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseDate(value), [value]);
  // The visible month — seeded from the value, advanced via the chevrons.
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selected ?? todayLocal()));

  const minuteOptions = useMemo(() => buildMinuteOptions(selected), [selected]);

  // All edits funnel through here: take the current (or a freshly defaulted)
  // date, apply one mutation, emit the ISO string.
  const commit = (mutate: (d: Date) => void) => {
    const base = selected ? new Date(selected) : defaultDateTime();
    mutate(base);
    onChange(base.toISOString());
  };

  const hours24 = selected?.getHours() ?? 9;
  const isPm = hours24 >= 12;
  const hour12 = String(((hours24 + 11) % 12) + 1);
  const minute = selected ? pad(selected.getMinutes()) : "00";

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-xl px-3 text-left text-sm",
            "bg-app-bg-1 text-app-fg-4 app-elevated app-press",
            "outline-none transition-shadow",
            "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
            "data-[state=open]:ring-2 data-[state=open]:ring-app-purple-2 data-[state=open]:ring-offset-4 data-[state=open]:ring-offset-app-background",
            "disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
        >
          <CalendarDays size={14} className="shrink-0 text-app-fg-2" />
          <span className={cn("min-w-0 flex-1 truncate", selected ? undefined : "text-app-fg-2")}>
            {selected ? formatTrigger(selected) : placeholder}
          </span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className={cn(
            "z-50 w-[19rem] rounded-2xl bg-app-bg-1 p-3",
            "shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none app-fade-in",
          )}
        >
          {/* Month header */}
          <div className="flex items-center justify-between px-1">
            <p className="text-[13px] font-medium text-app-fg-4">{monthLabel(viewMonth)}</p>
            <div className="flex items-center gap-1">
              <NavButton
                label="Previous month"
                onClick={() => setViewMonth((m) => addMonths(m, -1))}
              >
                <ChevronLeft size={15} />
              </NavButton>
              <NavButton label="Next month" onClick={() => setViewMonth((m) => addMonths(m, 1))}>
                <ChevronRight size={15} />
              </NavButton>
            </div>
          </div>

          {/* Weekday row */}
          <div className="mt-2 grid grid-cols-7 gap-0.5">
            {WEEKDAYS.map((d, i) => (
              <div
                key={i}
                className="grid h-7 place-items-center text-[11px] font-medium text-app-fg-2"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {monthGrid(viewMonth).map((day) => {
              const inMonth = day.getMonth() === viewMonth.getMonth();
              const isSelected = selected ? isSameDay(day, selected) : false;
              const isToday = isSameDay(day, todayLocal());
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  onClick={() =>
                    commit((d) => {
                      d.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
                    })
                  }
                  className={cn(
                    "grid h-8 place-items-center rounded-lg text-[13px] tabular-nums outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-app-purple-2",
                    isSelected
                      ? "bg-[image:var(--app-cta-bg)] text-[var(--app-accent-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                      : cn(
                          inMonth ? "text-app-fg-4" : "text-app-fg-1",
                          "hover:bg-app-bg-a1",
                          isToday ? "shadow-[inset_0_0_0_1px_var(--app-purple-2)]" : undefined,
                        ),
                  )}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          {/* Time controls */}
          <div className="mt-3 flex items-center gap-2 border-t border-app-bg-3 pt-3">
            <AppSelect
              value={hour12}
              onChange={(next) => {
                if (!next) return;
                commit((d) => d.setHours(to24Hour(Number(next), isPm), d.getMinutes()));
              }}
              options={HOUR_OPTIONS}
              className="w-[4.75rem] px-2.5"
            />
            <span className="text-app-fg-2">:</span>
            <AppSelect
              value={minute}
              onChange={(next) => {
                if (!next) return;
                commit((d) => d.setMinutes(Number(next)));
              }}
              options={minuteOptions}
              className="w-[4.75rem] px-2.5"
            />
            <AppSegmented
              className="ml-auto"
              label="AM or PM"
              value={isPm ? "pm" : "am"}
              onValueChange={(meridiem) =>
                commit((d) =>
                  d.setHours(to24Hour(hour12 === "" ? 12 : Number(hour12), meridiem === "pm")),
                )
              }
              items={[
                { value: "am", label: "AM" },
                { value: "pm", label: "PM" },
              ]}
            />
          </div>

          {selected ? (
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className={cn(
                "mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-lg text-[12px] text-app-fg-3 outline-none",
                "hover:bg-app-bg-a1 hover:text-app-fg-4 focus-visible:ring-2 focus-visible:ring-app-purple-2",
              )}
            >
              <X size={12} />
              Clear
            </button>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-lg text-app-fg-3 outline-none transition-colors",
        "hover:bg-app-bg-a1 hover:text-app-fg-4 focus-visible:ring-2 focus-visible:ring-app-purple-2",
      )}
    >
      {children}
    </button>
  );
}

/* ── date helpers (all local-time) ─────────────────────────────────────── */

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function todayLocal(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** A sensible default when the field starts empty: today at 09:00 local. */
function defaultDateTime(): Date {
  const d = todayLocal();
  d.setHours(9, 0, 0, 0);
  return d;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

/** 6 weeks (42 cells) covering the month, padded with adjacent days. */
function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function to24Hour(hour12: number, pm: boolean): number {
  const base = hour12 % 12;
  return pm ? base + 12 : base;
}

function buildMinuteOptions(selected: Date | null): AppSelectOption[] {
  const steps = new Set<number>();
  for (let m = 0; m < 60; m += 5) steps.add(m);
  if (selected) steps.add(selected.getMinutes());
  return [...steps].sort((a, b) => a - b).map((m) => ({ value: pad(m), label: pad(m) }));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatTrigger(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
