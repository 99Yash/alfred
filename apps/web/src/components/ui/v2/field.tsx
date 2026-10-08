/**
 * Form field layout: label, control, helper or error. Works with a TanStack `Field`.
 * The leaves are exported for controls that render their own wrapper.
 */

import { AlertCircle } from "lucide-react";
import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "~/lib/utils";

interface AppFieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  optional?: boolean | undefined;
}

export function AppFieldLabel({ className, optional, children, ...rest }: AppFieldLabelProps) {
  return (
    <label className={cn("px-1 text-sm font-medium text-app-fg-4", className)} {...rest}>
      {children}
      {optional ? <span className="text-app-fg-2"> (optional)</span> : null}
    </label>
  );
}

type AppFieldHelperTextProps = HTMLAttributes<HTMLParagraphElement>;

/** Point `aria-describedby` at its `id`. */
export function AppFieldHelperText({ className, ...rest }: AppFieldHelperTextProps) {
  return <p className={cn("px-1 text-xs text-app-fg-3", className)} {...rest} />;
}

type AppFieldErrorProps = HTMLAttributes<HTMLParagraphElement>;

/** Point `aria-errormessage` at its `id`; the control's `aria-invalid` carries the state. */
export function AppFieldError({ className, children, ...rest }: AppFieldErrorProps) {
  return (
    <p className={cn("flex items-start gap-1 px-1 text-xs text-app-red-4", className)} {...rest}>
      <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

interface AppFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label?: ReactNode | undefined;
  /** Required whenever `label` renders. */
  htmlFor?: string | undefined;
  optional?: boolean | undefined;
  helperText?: ReactNode | undefined;
  error?: string | undefined;
  errorId?: string | undefined;
  children: ReactNode;
}

export function AppField({
  label,
  htmlFor,
  optional,
  helperText,
  error,
  errorId,
  className,
  children,
  ...rest
}: AppFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)} {...rest}>
      {label ? (
        <AppFieldLabel htmlFor={htmlFor} optional={optional}>
          {label}
        </AppFieldLabel>
      ) : null}
      {children}
      {helperText ? <AppFieldHelperText>{helperText}</AppFieldHelperText> : null}
      {error ? <AppFieldError id={errorId}>{error}</AppFieldError> : null}
    </div>
  );
}
