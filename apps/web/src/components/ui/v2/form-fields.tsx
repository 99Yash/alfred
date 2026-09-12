/**
 * App-grammar field components for the app-form hook.
 *
 * Each one reads its own `FieldApi` from context, so a call site names the
 * field once and never wires `value` / `onChange` / `onBlur` / `aria-*` by
 * hand. They are registered as `field.TextField`, `field.TextAreaField` in
 * `form.ts` and used inside `form.AppField`.
 *
 * Validation errors are read on blur only, matching the rest of the app: a
 * half-typed value is not yet an error.
 */

import { isNonEmptyString, isRecord } from "@alfred/contracts";
import type { ComponentProps, ReactNode } from "react";
import { AppField } from "./field";
import { useFieldContext } from "./form-context";
import { AppInput } from "./input";
import { AppTextarea } from "./textarea";

/**
 * A validator may answer with a bare string or with a schema issue that
 * carries `message`. Normalize both to the one string the error slot renders.
 */
function fieldErrorMessage(error: unknown): string | undefined {
  if (isNonEmptyString(error)) return error;

  if (isRecord(error) && isNonEmptyString(error.message)) return error.message;

  return undefined;
}

interface AppFieldChrome {
  label?: ReactNode | undefined;
  optional?: boolean | undefined;
  helperText?: ReactNode | undefined;
}

type AppTextFieldProps = AppFieldChrome &
  Omit<ComponentProps<typeof AppInput>, "id" | "name" | "value" | "onChange" | "onBlur">;

export function AppTextField({ label, optional, helperText, ...inputProps }: AppTextFieldProps) {
  const field = useFieldContext<string>();

  const error = field.state.meta.isBlurred
    ? fieldErrorMessage(field.state.meta.errors[0])
    : undefined;

  const errorId = `${field.name}-error`;

  return (
    <AppField
      label={label}
      htmlFor={field.name}
      optional={optional}
      helperText={helperText}
      error={error}
      errorId={errorId}
    >
      <AppInput
        id={field.name}
        name={field.name}
        value={field.state.value}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={error ? true : undefined}
        aria-errormessage={error ? errorId : undefined}
        {...inputProps}
      />
    </AppField>
  );
}

type AppTextAreaFieldProps = AppFieldChrome &
  Omit<ComponentProps<typeof AppTextarea>, "id" | "name" | "value" | "onChange" | "onBlur">;

export function AppTextAreaField({
  label,
  optional,
  helperText,
  ...textareaProps
}: AppTextAreaFieldProps) {
  const field = useFieldContext<string>();

  const error = field.state.meta.isBlurred
    ? fieldErrorMessage(field.state.meta.errors[0])
    : undefined;

  const errorId = `${field.name}-error`;

  return (
    <AppField
      label={label}
      htmlFor={field.name}
      optional={optional}
      helperText={helperText}
      error={error}
      errorId={errorId}
    >
      <AppTextarea
        id={field.name}
        name={field.name}
        value={field.state.value}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={error ? true : undefined}
        aria-errormessage={error ? errorId : undefined}
        {...textareaProps}
      />
    </AppField>
  );
}
