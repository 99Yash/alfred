import { render } from "@react-email/render";
import * as React from "react";
import { WorkflowBlockedEmail, type WorkflowBlockedEmailProps } from "./workflow-blocked";

/**
 * Render the workflow-blocked email to an HTML string for sending. Lives apart
 * from the component file so that file exports only components and Fast
 * Refresh can keep its state in the email preview.
 */
export const renderWorkflowBlockedEmail = (props: WorkflowBlockedEmailProps): Promise<string> =>
  render(<WorkflowBlockedEmail {...props} />);
