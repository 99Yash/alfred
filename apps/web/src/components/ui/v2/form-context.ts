/** The app-form contexts, apart from `form.ts` so field components avoid an import cycle. */

import { createFormHookContexts } from "@tanstack/react-form";

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();
