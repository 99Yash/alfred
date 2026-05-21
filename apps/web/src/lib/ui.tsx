/**
 * Shared presentational primitives. Kept intentionally small — these are the
 * patterns the workspace pages (Notes / Memory / Skills) share so the tone
 * doesn't drift. Anything component-level (composers, etc.) lives in the
 * route that owns it.
 */

import type { ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";

/* -------------------------------------------------------------------------- */
/* Page-level scaffolding                                                     */
/* -------------------------------------------------------------------------- */

export function PageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-8",
        className,
      )}
    >
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
      <div className="md:hidden h-6" />
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="space-y-1.5 min-w-0">
        {eyebrow ? (
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-serif text-3xl sm:text-4xl tracking-tight leading-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground max-w-prose">{description}</p>
        ) : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </header>
  );
}

export function SectionHeader({
  title,
  count,
  description,
  right,
}: {
  title: string;
  count?: number;
  description?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="space-y-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
            {title}
          </h2>
          {typeof count === "number" ? (
            <span className="text-[11px] text-muted-foreground/70 tabular">{count}</span>
          ) : null}
        </div>
        {description ? <p className="text-[12.5px] text-muted-foreground">{description}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Cards / rows                                                                */
/* -------------------------------------------------------------------------- */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border bg-card text-card-foreground shadow-soft", className)}>
      {children}
    </div>
  );
}

/** Same look as `Card` but rendered as a styling class string for cases where
 * the consumer needs to pass it onto a non-div element (Link, button, etc.). */
export const cardClasses = "rounded-lg border bg-card text-card-foreground shadow-soft";

export function CardRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border bg-card px-4 py-3", className)}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  dashed = true,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg bg-card/30 px-6 py-10 text-center space-y-3",
        dashed ? "border border-dashed" : "border",
      )}
    >
      {icon ? (
        <div className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-[12.5px] text-muted-foreground max-w-prose mx-auto">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Form primitives                                                             */
/* -------------------------------------------------------------------------- */

export function Input({
  className,
  ref,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        "block w-full rounded-md border bg-background px-3 py-2 text-sm",
        "outline-none transition-shadow",
        "placeholder:text-muted-foreground/70",
        "focus:ring-2 focus:ring-ring/40 focus:border-foreground/40",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ref,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "block w-full rounded-md border bg-background px-3 py-2 text-sm",
        "outline-none transition-shadow resize-y min-h-[80px]",
        "placeholder:text-muted-foreground/70",
        "focus:ring-2 focus:ring-ring/40 focus:border-foreground/40",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-foreground text-background hover:bg-foreground/90 disabled:bg-foreground/40",
  secondary: "border bg-background text-foreground hover:bg-accent/60 disabled:opacity-50",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-50",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1",
  md: "h-9 px-4 text-sm gap-1.5",
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  ref,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium",
        "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

/**
 * Icon-only chrome button used inside composer chip rows (attach, mic, etc.).
 * Square-ish min hit target (32×32) with quiet ghost styling.
 */
export function ToolButton({
  label,
  className,
  children,
  ref,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type={props.type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center min-w-8 h-8 px-1.5 rounded-md",
        "text-muted-foreground hover:text-foreground hover:bg-accent/60",
        "transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Pills & badges                                                              */
/* -------------------------------------------------------------------------- */

type PillTone = "neutral" | "positive" | "warning" | "negative" | "info";

const PILL_TONE: Record<PillTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  positive: "bg-emerald-400/10 text-emerald-300",
  warning: "bg-amber-400/10 text-amber-300",
  negative: "bg-destructive/10 text-red-300",
  info: "bg-sky-400/10 text-sky-300",
};

export function Pill({
  tone = "neutral",
  className,
  children,
}: {
  tone?: PillTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
