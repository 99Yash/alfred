import { AlertCircle, Clock, RefreshCw, Sparkles, Sunrise, Sunset } from "lucide-react";
import { useMemo, type ComponentType, type ReactNode } from "react";
import { AppButton, AppCard, AppSelect, type AppSelectOption } from "~/components/ui/v2";
import { useBriefingSchedule } from "~/lib/replicache/use-briefing-schedule";

/**
 * Briefing delivery schedule — timezone + morning/evening hour pickers.
 *
 * Writes the three `briefing.*` preference rows the hourly cron reads
 * (`briefing.timezone`, `briefing.delivery_hour`, `briefing.evening_hour`).
 * Lives under the background-agent toggles since "when" only matters once a
 * briefing slot is switched on.
 */
export function BriefingScheduleSection() {
  const {
    timezone,
    morningHour,
    eveningHour,
    hasOverride,
    setTimezone,
    setMorningHour,
    setEveningHour,
    loading,
    error,
    retry,
  } = useBriefingSchedule();

  const timezoneOptions = useTimezoneOptions();
  const hourOptions = useMemo(
    () => HOURS.map((h) => ({ value: String(h), label: hourLabel(h) })),
    [],
  );

  // `resolvedOptions().timeZone` is the browser's IANA zone — offer a one-tap
  // fix when the stored value is still the server default (UTC) or otherwise
  // differs, since the default is almost never what the user wants.
  const deviceTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  }, []);
  const showDeviceHint = deviceTimezone !== null && deviceTimezone !== timezone;

  return (
    <AppCard padded={false}>
      <div className="p-5 pb-2 space-y-1">
        <p className="text-sm font-medium text-app-fg-4">Briefing schedule</p>
        <p className="text-xs text-app-fg-3">
          When your morning briefing and evening recap arrive.
        </p>
      </div>

      {error ? (
        <div
          className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
          role="alert"
        >
          <div className="flex min-w-0 gap-2.5">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-app-red-4" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-app-fg-4">Schedule unavailable</p>
              <p className="mt-1 text-xs leading-5 text-app-fg-3">{error}</p>
            </div>
          </div>
          <AppButton
            size="sm"
            variant="ghost"
            leading={<RefreshCw size={13} aria-hidden />}
            onClick={retry}
            className="shrink-0"
          >
            Retry
          </AppButton>
        </div>
      ) : (
        <div className="divide-y divide-app-bg-2">
          <ScheduleRow
            icon={Sparkles}
            tint="bg-app-purple-1 text-app-purple-4"
            label="Time zone"
            helper={
              hasOverride.timezone
                ? "Delivery times are interpreted in this zone."
                : "Defaulting to UTC — set your zone so briefings land at the right local hour."
            }
          >
            <AppSelect
              label="Time zone"
              value={timezone}
              onChange={(next) => {
                if (next) void setTimezone(next);
              }}
              options={timezoneOptions}
              leading={<Clock size={14} aria-hidden />}
              disabled={loading}
              className="w-64"
            />
          </ScheduleRow>

          <ScheduleRow
            icon={Sunrise}
            tint="bg-app-amber-1 text-app-amber-4"
            label="Morning briefing"
            helper={`Arrives at ${hourLabel(morningHour)} ${shortZone(timezone)}.`}
          >
            <AppSelect
              label="Morning briefing hour"
              value={String(morningHour)}
              onChange={(next) => {
                if (next) void setMorningHour(Number(next));
              }}
              options={hourOptions}
              disabled={loading}
              className="w-36"
            />
          </ScheduleRow>

          <ScheduleRow
            icon={Sunset}
            tint="bg-app-orange-1 text-app-orange-4"
            label="Evening recap"
            helper={`Arrives at ${hourLabel(eveningHour)} ${shortZone(timezone)}.`}
          >
            <AppSelect
              label="Evening recap hour"
              value={String(eveningHour)}
              onChange={(next) => {
                if (next) void setEveningHour(Number(next));
              }}
              options={hourOptions}
              disabled={loading}
              className="w-36"
            />
          </ScheduleRow>
        </div>
      )}

      {!error && showDeviceHint && deviceTimezone ? (
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <p className="text-xs text-app-fg-3">
            Detected device zone:{" "}
            <span className="text-app-fg-4">{labelForZone(deviceTimezone)}</span>
          </p>
          <AppButton
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void setTimezone(deviceTimezone)}
          >
            Use this
          </AppButton>
        </div>
      ) : null}
    </AppCard>
  );
}

function ScheduleRow({
  icon: Icon,
  tint,
  label,
  helper,
  children,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  tint: string;
  label: string;
  helper: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`grid size-8 shrink-0 place-items-center rounded-xl ${tint}`} aria-hidden>
          <Icon size={14} />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-app-fg-4">{label}</p>
          <p className="text-xs text-app-fg-3">{helper}</p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** "7:00 AM", "6:00 PM" — a stable label for an hour-of-day 0–23. */
function hourLabel(hour: number): string {
  const d = new Date(Date.UTC(2000, 0, 1, hour, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(d);
}

/** Compact display label for an IANA zone: "Asia/Kolkata · GMT+5:30". */
function labelForZone(zone: string): string {
  const pretty = zone.replace(/_/g, " ");
  const offset = shortOffset(zone);
  return offset ? `${pretty} · ${offset}` : pretty;
}

/** Just the short zone token for inline helper text ("IST", "GMT+5:30", "UTC"). */
function shortZone(zone: string): string {
  return shortOffset(zone) ?? zone;
}

function shortOffset(zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(Date.UTC(2000, 0, 1, 12)));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Full IANA zone list for the picker. `Intl.supportedValuesOf` omits the
 * "UTC" alias (the very gap that broke briefings), so prepend it explicitly.
 */
function useTimezoneOptions(): ReadonlyArray<AppSelectOption> {
  return useMemo(() => {
    let zones: string[];
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = [];
    }
    return ["UTC", ...zones].map((zone) => ({ value: zone, label: labelForZone(zone) }));
  }, []);
}
