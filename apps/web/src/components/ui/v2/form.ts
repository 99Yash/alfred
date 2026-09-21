/**
 * App-grammar form hook.
 *
 * `useAppForm` is `useForm` plus the registered `field.*` components, so a
 * field reads:
 *
 *     <form.AppField name="endpointUrl" validators={...}>
 *       {(field) => <field.TextField label="Server URL" />}
 *     </form.AppField>
 *
 * and the component owns the input wiring and the error slot. Register a new
 * control here once, then every form can use it.
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
