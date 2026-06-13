import { Check, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import { getLocalStorageItem } from '~/lib/storage';
import { cn } from '~/lib/utils';

/**
 * Semantic intent. Every intent shares the same calm neutral card and only the
 * leading icon disc (plus a soft edge-glow) carries the color; `error` adds a
 * red hairline ring on top so a failure still reads clearly without flooding
 * the whole card red. `danger` is kept as a back-compat alias for `error`.
 */
export type ToastVariant = 'default' | 'success' | 'info' | 'warning' | 'error';
type LegacyVariant = ToastVariant | 'danger';

/** Where the toast docks. Generic action/confirmation toasts read best in a
 * corner; status and errors stay top-center where the eye already is. */
export type ToastPosition =
  | 'top-center'
  | 'top-right'
  | 'bottom-right'
  | 'bottom-center';

interface CallToastOptions {
  message: ReactNode;
  description?: ReactNode;
  /** Semantic intent. Drives the default icon and tint. Defaults to `default`. */
  variant?: ToastVariant;
  /** @deprecated use `variant`. `"danger"` maps to `"error"`. */
  type?: LegacyVariant;
  /** Auto-dismiss in ms. */
  duration?: number;
  /** Override the per-variant default icon. Pass `null` to suppress it. */
  icon?: ReactNode | null;
  /** Dock location. Defaults to `top-right`. */
  position?: ToastPosition;
  /**
   * Optional inline action (e.g. "Undo"). Clicking it runs `onClick` and
   * dismisses the toast. Pair with a `duration` so the window matches the
   * caller's deferred commit.
   */
  action?: { label: string; onClick: () => void };
}

interface VariantSpec {
  /** Card-level modifier (only `error` uses it — for the red hairline ring). */
  cardClass?: string;
  /** Icon disc tint + icon accent. */
  iconClass: string;
  /** Default leading icon for the variant. */
  icon: ReactNode | null;
}

const ICON_SIZE = 14;

const VARIANTS: Record<ToastVariant, VariantSpec> = {
  default: { iconClass: '', icon: null },
  success: {
    iconClass: 'app-toast-icon--success',
    icon: <Check size={ICON_SIZE} strokeWidth={2.5} />,
  },
  info: {
    iconClass: 'app-toast-icon--info',
    icon: <Info size={ICON_SIZE} strokeWidth={2.25} />,
  },
  warning: {
    iconClass: 'app-toast-icon--warning',
    icon: <TriangleAlert size={ICON_SIZE} strokeWidth={2.25} />,
  },
  error: {
    cardClass: 'app-toast--danger',
    iconClass: 'app-toast-icon--danger',
    icon: <X size={ICON_SIZE} strokeWidth={2.5} />,
  },
};

function normalizeVariant(
  variant?: ToastVariant,
  legacy?: LegacyVariant,
): ToastVariant {
  if (variant) return variant;
  if (legacy === 'danger') return 'error';
  return legacy ?? 'default';
}

/**
 * Resolve the app-grammar theme attribute the same way `<AppThemed>` does.
 * sonner renders the toast outside the themed subtree, so without this the
 * card's `--app-*` tokens fall back to the light `:root` values and a dark
 * shell gets a jarring white card. `undefined` = system — let the `@media`
 * block in `index.css` resolve it.
 */
function appThemeAttr(): 'dark' | 'light' | undefined {
  const mode = getLocalStorageItem('app-theme');
  return mode === 'dark' || mode === 'light' ? mode : undefined;
}

/**
 * Frosted toast — a translucent, blurred card with a theme-aware hairline and
 * a soft drop, ported from dimension's `callToast` and grown semantic intents.
 * Sits on top of the `sonner` <Toaster> mounted in `__root`. Use the
 * convenience helpers (`toast.success`, `toast.error`, …) for the common cases
 * and this base for anything bespoke.
 */
export function callToast({
  message,
  description,
  variant,
  type,
  duration = 5000,
  icon,
  position = 'top-right',
  action,
}: CallToastOptions): string | number {
  const intent = normalizeVariant(variant, type);
  const spec = VARIANTS[intent];
  // `null` suppresses; `undefined` falls back to the variant default.
  const leadingIcon = icon === undefined ? spec.icon : icon;
  // Single-line toasts center everything on the text's optical middle; only a
  // wrapping description warrants top-aligning the icon and close button.
  const multiline = Boolean(description);

  return sonnerToast.custom(
    (id) => (
      <div
        className={cn(
          'app app-toast pointer-events-auto flex w-88 max-w-[calc(100vw-2rem)] gap-2.5 rounded-2xl px-3 py-2.5',
          multiline ? 'items-start' : 'items-center',
          spec.cardClass,
        )}
        data-app-theme={appThemeAttr()}
        data-variant={intent}
      >
        {leadingIcon ? (
          <span
            className={cn(
              'app-toast-icon grid size-7 shrink-0 place-items-center rounded-full',
              multiline && 'mt-px',
              spec.iconClass,
            )}
          >
            {leadingIcon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
          <span className="text-balance text-[13px] font-medium leading-snug">
            {message}
          </span>
          {description ? (
            <span className="text-pretty text-[12px] leading-snug text-app-fg-3">
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
              '-my-0.5 shrink-0 self-center rounded-lg px-2.5 py-1 text-[12.5px] font-semibold',
              // A resting fill + hairline so the action reads as a button at a
              // glance, not hover-revealed text; it firms up on hover.
              'bg-app-bg-a2 text-app-fg-4 ring-1 ring-inset ring-app-fg-a1/60',
              'transition-[background-color,box-shadow,transform] duration-150 hover:ring-app-fg-a1 active:scale-[0.96]',
              'outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2',
            )}
          >
            {action.label}
          </button>
        ) : null}
        {/* Sonner's signature affordance: a small circular X cut into the
         * top-right corner, always visible so dismissal is one click away. */}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => sonnerToast.dismiss(id)}
          className={cn(
            'app-toast-close absolute right-0 top-0 grid size-5 -translate-y-1/3 translate-x-1/3 place-items-center rounded-full',
            'outline-none focus-visible:ring-2 focus-visible:ring-app-fg-a2',
          )}
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
    ),
    { duration, position },
  );
}

type Shorthand =
  | string
  | (Omit<CallToastOptions, 'variant' | 'type'> & { message: ReactNode });

function shorthand(variant: ToastVariant, defaultPosition: ToastPosition) {
  return (input: Shorthand): string | number => {
    const opts = typeof input === 'string' ? { message: input } : input;
    return callToast({ position: defaultPosition, ...opts, variant });
  };
}

/**
 * One emoji, one line — a featherweight confirmation with a giant blurred
 * emoji bleeding off the leading edge. Ported from dimension's emoji toast and
 * retuned to app-grammar tokens. Reach for it on light, happy moments ("turn
 * finished", "copied") where a full status card would be too much. Click or
 * wait to dismiss.
 */
export function emojiToast({
  emoji,
  label,
  duration = 4000,
  position = 'bottom-right',
}: {
  emoji: string;
  label: ReactNode;
  duration?: number;
  position?: ToastPosition;
}): string | number {
  return sonnerToast.custom(
    (id) => (
      <button
        type="button"
        onClick={() => sonnerToast.dismiss(id)}
        className={cn(
          'app app-toast app-toast--emoji pointer-events-auto relative isolate flex w-full min-w-60 max-w-xs items-center overflow-hidden rounded-2xl px-3 py-2.5 text-left',
          'transition-transform duration-150 active:scale-[0.98]',
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
        <span className="relative flex min-w-0 select-none items-center gap-2.5">
          <span className="flex size-7 flex-none items-center justify-center text-xl">
            {emoji}
          </span>
          <span className="truncate text-balance text-[13px] font-medium leading-snug text-app-fg-4">
            {label}
          </span>
        </span>
      </button>
    ),
    { duration, position },
  );
}

/**
 * The everyday surface. `toast.success("Saved")` and friends; pass an options
 * object for descriptions, actions, or a position override. Status-y intents
 * (`error`) stay top-center; light confirmations dock bottom-right.
 */
export const toast = {
  message: (input: Shorthand) => shorthand('default', 'top-right')(input),
  success: shorthand('success', 'bottom-right'),
  info: shorthand('info', 'bottom-right'),
  warning: shorthand('warning', 'top-center'),
  error: shorthand('error', 'top-center'),
  emoji: emojiToast,
  custom: callToast,
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};
