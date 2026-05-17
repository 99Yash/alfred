import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUp,
  ChevronDown,
  Mic,
  Paperclip,
  Plug,
  Plus,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { useRightRail } from "~/lib/app-shell";
import { client } from "~/lib/eden";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: () => client.health.get(),
    staleTime: 30_000,
  });

  const name = displayName(session?.user);
  const now = useNow();
  const greeting = useMemo(() => greetingFor(now), [now]);
  const longDate = useMemo(() => formatLongDate(now), [now]);

  const healthOk = Boolean(health?.data && "ok" in health.data && health.data.ok);

  // Right-rail widget — date / status / quick suggestions placeholder. Memoize
  // the node so its identity is stable while deps haven't changed — otherwise
  // we'd loop the AppShell state on every render.
  const rightRail = useMemo(
    () =>
      session?.user ? (
        <HomeRightRail
          longDate={longDate}
          healthOk={healthOk}
          healthLoading={healthLoading}
        />
      ) : null,
    [session?.user, longDate, healthOk, healthLoading],
  );
  useRightRail(rightRail);

  // Logged out — show a quiet landing without the full shell chrome.
  if (!sessionPending && !session?.user) {
    return (
      <div className="min-h-[100dvh] grid place-items-center px-6">
        <div className="text-center space-y-4">
          <h1 className="font-serif text-5xl tracking-tight">Alfred</h1>
          <p className="text-sm text-muted-foreground">
            Server: {healthLoading ? "checking…" : healthOk ? "online" : "not reachable"}
          </p>
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm hover:bg-accent/60 transition-colors"
          >
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col">
      {/* Top spacer to keep the mobile hamburger from colliding with the title */}
      <div className="md:hidden h-14 shrink-0" />

      <div className="flex-1 grid place-items-center px-4 sm:px-6 lg:px-10">
        <div className="w-full max-w-2xl space-y-8 -mt-16 md:-mt-8">
          <header className="text-center space-y-2">
            <p className="text-[12px] tracking-wide text-muted-foreground tabular">
              {longDate}
            </p>
            <h1 className="font-serif text-3xl sm:text-4xl md:text-5xl tracking-tight leading-tight">
              {greeting},{" "}
              <span className="italic text-muted-foreground/90">{name}</span>
            </h1>
          </header>

          <Composer />

          <div className="flex flex-wrap items-center justify-center gap-2">
            <ChipLink href="/skills" icon={<Sparkles size={13} />}>
              Teach Alfred a skill
            </ChipLink>
            <ChipLink href="/memory" icon={<Wand2 size={13} />}>
              Review memory
            </ChipLink>
            <ChipLink href="/notes" icon={<Paperclip size={13} />}>
              Capture a note
            </ChipLink>
          </div>

          <p className="text-center text-[11px] text-muted-foreground/80">
            <Plug size={11} className="inline -mt-0.5 mr-1" />
            <span>Chat surface lands with m13.</span>{" "}
            <span className="opacity-70">
              The composer above is a preview — input is logged, not sent.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Composer() {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const hasContent = value.trim().length > 0;

  const send = () => {
    if (!hasContent) return;
    // Stubbed until m13 lands the chat surface.
    // eslint-disable-next-line no-console
    console.info("[alfred] composer submit:", value.trim());
    setValue("");
    queueMicrotask(() => ref.current?.focus());
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className={cn(
        "relative rounded-2xl border bg-card shadow-soft",
        "focus-within:ring-2 focus-within:ring-ring/40 focus-within:border-foreground/40",
        "transition-shadow",
      )}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        placeholder="Type and press enter to start chatting…"
        className={cn(
          "block w-full resize-none bg-transparent px-4 pt-4 pb-2",
          "text-[15px] leading-relaxed outline-none",
          "placeholder:text-muted-foreground/70",
          "max-h-[40dvh]",
        )}
      />

      <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1.5">
        <div className="flex items-center gap-1">
          <ToolButton label="Add files & mentions" disabled>
            <Plus size={16} />
          </ToolButton>
          <AutoToggle on />
          <ModelPicker value="Default" />
        </div>

        <div className="flex items-center gap-1">
          <ToolButton label="Voice input" disabled>
            <Mic size={15} />
          </ToolButton>
          <button
            type="submit"
            disabled={!hasContent}
            aria-label="Send"
            className={cn(
              "inline-flex items-center justify-center size-8 rounded-full",
              "transition-colors",
              hasContent
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-muted text-muted-foreground/70 cursor-not-allowed",
            )}
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Bespoke neumorphic toggle for "Auto" mode. Mirrors dimension's composer
 * primitive (`#0f0f0f → #1e1e1e` off, `#141414 → rgba(20,20,20,0.5)` on).
 * Disabled until m13 ships the boss agent; the toggle is decorative for now.
 */
function AutoToggle({ on }: { on: boolean }) {
  return (
    <button
      type="button"
      disabled
      aria-pressed={on}
      title="Auto mode (boss model picks the agent)"
      className={cn(
        "inline-flex items-center justify-center h-[31px] min-w-[71px] px-3",
        "rounded-[10px] backdrop-blur-sm",
        "border border-white/5 dark:border-white/5",
        "text-[12px] font-medium tabular text-foreground/90",
        "transition-opacity disabled:cursor-not-allowed disabled:opacity-90",
        on
          ? "bg-gradient-to-b from-[#141414] to-[#141414]/50"
          : "bg-gradient-to-b from-[#0f0f0f] to-[#1e1e1e]",
      )}
    >
      Auto
    </button>
  );
}

/**
 * Model-picker chip. Semantic tiers only ("Default" / "Pro") — never provider
 * names. Disabled until m13/m14 land actual model routing.
 */
function ModelPicker({ value }: { value: string }) {
  return (
    <button
      type="button"
      disabled
      title="Model picker — lands with m13"
      className={cn(
        "inline-flex items-center gap-1 h-8 px-2.5 rounded-md",
        "text-[12px] font-medium text-muted-foreground",
        "hover:text-foreground hover:bg-accent/60",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-80",
      )}
    >
      {value}
      <ChevronDown size={12} className="opacity-70" />
    </button>
  );
}

function ToolButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center min-w-8 h-8 px-1.5 rounded-md",
        "text-muted-foreground hover:text-foreground hover:bg-accent/60",
        "transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

function ChipLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-card/40",
        "px-3 py-1 text-[12px] text-muted-foreground",
        "hover:bg-accent/60 hover:text-foreground transition-colors",
      )}
    >
      <span className="opacity-80">{icon}</span>
      {children}
    </a>
  );
}

/* -------------------------------------------------------------------------- */

function HomeRightRail({
  longDate,
  healthOk,
  healthLoading,
}: {
  longDate: string;
  healthOk: boolean;
  healthLoading: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="px-4 py-3 border-b">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
          Today
        </p>
        <p className="text-[14px] font-medium mt-0.5">{longDate}</p>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar p-4 space-y-5">
        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
            Suggestions
          </p>
          <div className="rounded-md border bg-background/60 p-3 text-[12.5px] text-muted-foreground italic">
            Alfred will surface proactive suggestions here once integrations are
            connected and the boss agent is wired (m13).
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
            Morning briefing
          </p>
          <div className="rounded-md border bg-background/60 p-3 text-[12.5px] text-muted-foreground">
            Daily digest delivers each morning. Configure timezone & hour in
            Settings.
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
            Status
          </p>
          <div className="rounded-md border bg-background/60 p-3 text-[12px] space-y-1">
            <Row label="Server">
              {healthLoading ? (
                <span className="text-muted-foreground">checking…</span>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    healthOk ? "text-emerald-500" : "text-destructive",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      healthOk ? "bg-emerald-500" : "bg-destructive",
                    )}
                  />
                  {healthOk ? "online" : "offline"}
                </span>
              )}
            </Row>
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function displayName(user: SessionUser | null | undefined): string {
  if (!user) return "there";
  if (user.name && user.name.trim().length > 0) {
    const first = user.name.trim().split(/\s+/)[0];
    if (first) return first;
  }
  if (user.email) {
    const local = user.email.split("@")[0];
    if (local && local.length > 0) {
      return local
        .replace(/[._-]+/g, " ")
        .split(" ")
        .map(capitalize)
        .filter(Boolean)
        .join(" ") || local;
    }
  }
  return "there";
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Re-ticks the "now" reference every minute so the greeting transitions
 * (morning → afternoon → evening) even if the tab stays open across the
 * boundary. Cheap; no animation, just a re-render.
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
