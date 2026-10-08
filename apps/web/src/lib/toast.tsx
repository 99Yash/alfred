import { Check, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { toast as sonnerToast } from "sonner";
import { getLocalStorageItem } from "~/lib/storage/storage";
import { cn } from "~/lib/utils";

/** Only the icon disc carries color; `error` adds a red hairline ring. */
export type ToastVariant = "default" | "success" | "info" | "warning" | "error";

type LegacyVariant = ToastVariant | "danger";

export type ToastPosition = "top-center" | "top-right" | "bottom-right" | "bottom-center";

interface CallToastOptions {
  message: ReactNode;
  description?: ReactNode | undefined;
  /** Sets the default icon and tint. */
  variant?: ToastVariant | undefined;
  /** @deprecated use `variant`. `"danger"` maps to `"error"`. */
  type?: LegacyVariant | undefined;
  /** Auto-dismiss in ms. */
  duration?: number | undefined;
  /** `null` hides the icon. */
  icon?: ReactNode | null | undefined;
  /** Default `top-right`. */
  position?: ToastPosition | undefined;
  /** Runs `onClick`, then dismisses. For "Undo", match `duration` to the deferred commit. */
  action?: { label: string; onClick: () => void };
}

interface VariantSpec {
  /** Only `error` uses it. */
  cardClass?: string | undefined;
  iconClass: string;
  icon: ReactNode | null;
}

const ICON_SIZE = 14;

const VARIANTS = {
  default: { cardClass: undefined, iconClass: "", icon: null },
  success: {
    cardClass: undefined,
    iconClass: "app-toast-icon--success",
    icon: <Check size={ICON_SIZE} strokeWidth={2.5} />,
  },
  info: {
    cardClass: undefined,
    iconClass: "app-toast-icon--info",
    icon: <Info size={ICON_SIZE} strokeWidth={2.25} />,
  },
  warning: {
    cardClass: undefined,
    iconClass: "app-toast-icon--warning",
    icon: <TriangleAlert size={ICON_SIZE} strokeWidth={2.25} />,
  },
  error: {
    cardClass: "app-toast--danger",
    iconClass: "app-toast-icon--danger",
    icon: <X size={ICON_SIZE} strokeWidth={2.5} />,
  },
} satisfies Record<ToastVariant, VariantSpec>;

function normalizeVariant(variant?: ToastVariant, legacy?: LegacyVariant): ToastVariant {
  if (variant) return variant;

  if (legacy === "danger") return "error";

  return legacy ?? "default";
}

/**
 * Sonner renders outside the themed subtree, so set the theme as `<AppThemed>` does,
 * or a dark shell gets a white card. `undefined` means system.
 */
function appThemeAttr(): "dark" | "light" | undefined {
  const mode = getLocalStorageItem("app-theme");

  return mode === "dark" || mode === "light" ? mode : undefined;
}

/** The frosted toast card. Prefer the `toast.*` helpers; use this for custom cases. */
export function callToast({
  message,
  description,
  variant,
  type,
  duration = 5000,
  icon,
  position = "top-right",
  action,
}: CallToastOptions): string | number {
  const intent = normalizeVariant(variant, type);
  const spec = VARIANTS[intent];
  // `null` suppresses; `undefined` falls back to the variant default.
  const leadingIcon = icon === undefined ? spec.icon : icon;
  // Top-align the icon and close button only when a description can wrap.
  const multiline = Boolean(description);

  return sonnerToast.custom(
    (id) => (
      <div
        className={cn(
          "app app-toast pointer-events-auto flex w-88 max-w-[calc(100vw-2rem)] gap-2.5 rounded-2xl px-3 py-2.5",
          multiline ? "items-start" : "items-center",
          spec.cardClass,
        )}
        data-app-theme={appThemeAttr()}
        data-variant={intent}
      >
        {leadingIcon ? (
          <span
            className={cn(
              "app-toast-icon grid size-7 shrink-0 place-items-center rounded-full",
              multiline && "mt-px",
              spec.iconClass,
            )}
          >
            {leadingIcon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
          <span className="text-[13px] leading-snug font-medium text-balance">{message}</span>
          {description ? (
            <span className="text-[12px] leading-snug text-pretty text-app-fg-3">
              {description}
            </span>
          ) : null}
        </div>
        {action ? (
          <button
            type="button"
            onClick={() => {
              action.onClick();
              sonnerToast.dismiss(id);
            }}
            className={cn(
              "-my-0.5 shrink-0 self-center rounded-lg px-2.5 py-1 text-[12.5px] font-semibold",
              // A resting fill so it reads as a button before hover.
              "bg-app-bg-a2 text-app-fg-4 ring-1 ring-app-fg-a1/60 ring-inset",
              "transition-[background-color,box-shadow,transform] duration-150 hover:ring-app-fg-a1 active:scale-[0.96]",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2",
            )}
          >
            {action.label}
          </button>
        ) : null}
        {/* Always-visible close button in the top-right corner. */}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => sonnerToast.dismiss(id)}
          className={cn(
            "app-toast-close absolute top-0 right-0 grid size-5 translate-x-1/3 -translate-y-1/3 place-items-center rounded-full",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2",
          )}
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
    ),
    { duration, position },
  );
}

type Shorthand = string | (Omit<CallToastOptions, "variant" | "type"> & { message: ReactNode });

function shorthand(variant: ToastVariant, defaultPosition: ToastPosition) {
  return (input: Shorthand): string | number => {
    const opts = typeof input === "string" ? { message: input } : input;

    return callToast({ position: defaultPosition, ...opts, variant });
  };
}

/** A one-line confirmation with a large blurred emoji, for small happy moments. */
function emojiToast({
  emoji,
  label,
  duration = 4000,
  position = "bottom-right",
}: {
  emoji: string;
  label: ReactNode;
  duration?: number | undefined;
  position?: ToastPosition | undefined;
}): string | number {
  return sonnerToast.custom(
    (id) => (
      <button
        type="button"
        onClick={() => sonnerToast.dismiss(id)}
        className={cn(
          "app app-toast app-toast--emoji pointer-events-auto relative isolate flex w-full max-w-xs min-w-60 items-center overflow-hidden rounded-2xl px-3 py-2.5 text-left",
          "transition-transform duration-150 active:scale-[0.98]",
        )}
        data-app-theme={appThemeAttr()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 flex items-center mask-[linear-gradient(to_right,#000,transparent_72%)]"
        >
          <span className="origin-left translate-x-[-28%] text-[3.25em] opacity-15 blur-[2px] saturate-150 motion-safe:animate-[app-toast-emoji-in_420ms_cubic-bezier(0.2,0,0,1)]">
            {emoji}
          </span>
        </span>
        <span className="relative flex min-w-0 items-center gap-2.5 select-none">
          <span className="flex size-7 flex-none items-center justify-center text-xl">{emoji}</span>
          <span className="truncate text-[13px] leading-snug font-medium text-balance text-app-fg-4">
            {label}
          </span>
        </span>
      </button>
    ),
    { duration, position },
  );
}

/** Warnings and errors go top-center; success and info go bottom-right. */
export const toast = {
  message: (input: Shorthand) => shorthand("default", "top-right")(input),
  success: shorthand("success", "bottom-right"),
  info: shorthand("info", "bottom-right"),
  warning: shorthand("warning", "top-center"),
  error: shorthand("error", "top-center"),
  emoji: emojiToast,
  custom: callToast,
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};
