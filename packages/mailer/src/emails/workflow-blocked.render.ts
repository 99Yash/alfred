import { render } from "@react-email/render";
import { createElement } from "react";
import { WorkflowBlockedEmail, type WorkflowBlockedEmailProps } from "./workflow-blocked";

/**
 * Render the workflow-blocked email to an HTML string for sending. Lives apart
 * from the component file so that file exports only components and Fast
 * Refresh can keep its state in the email preview.
 *
 * Uses `createElement` instead of JSX on purpose: this package compiles with
 * the classic JSX runtime, but `apps/web` type-checks the same source with the
 * automatic runtime, where a JSX-only `React` import is an unused local.
 */
export const renderWorkflowBlockedEmail = (props: WorkflowBlockedEmailProps): Promise<string> =>
  render(createElement(WorkflowBlockedEmail, props));
