/**
 * Fields for the app-form hook. Each reads its `FieldApi` from context.
 * Errors show on blur only: a half-typed value is not yet an error.
 */

import { isNonEmptyString, isRecord } from "@alfred/contracts";
import type { ComponentProps, ReactNode } from "react";
import { AppField } from "./field";
import { useFieldContext } from "./form-context";
import { AppInput } from "./input";
import { AppTextarea } from "./textarea";

/** A validator returns a string or an issue with `message`. */
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
