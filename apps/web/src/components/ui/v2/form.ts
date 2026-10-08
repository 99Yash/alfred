/**
 * `useForm` plus the registered `field.*` components, used as
 * `{(field) => <field.TextField label="Server URL" />}` inside `form.AppField`.
 * Register a new control here once.
 */

import { createFormHook } from "@tanstack/react-form";
import { fieldContext, formContext } from "./form-context";
import { AppTextAreaField, AppTextField } from "./form-fields";

export const { useAppForm } = createFormHook({
  fieldComponents: {
    TextField: AppTextField,
    TextAreaField: AppTextAreaField,
  },
  formComponents: {},
  fieldContext,
  formContext,
});
