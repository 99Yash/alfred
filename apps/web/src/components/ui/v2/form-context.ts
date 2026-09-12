/**
 * The contexts the app-form hook binds.
 *
 * They live apart from `form.ts` so the field components can read
 * `useFieldContext` without importing the module that registers them, which
 * would be a cycle.
 */

import { createFormHookContexts } from "@tanstack/react-form";

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();
