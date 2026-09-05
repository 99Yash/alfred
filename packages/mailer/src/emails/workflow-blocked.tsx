import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/**
 * The "workflow blocked" email (#561). Sent once per blocker generation when a
 * scheduled or event-driven workflow cannot run because a capability it needs
 * is missing (a disconnected account, a lost scope, a dead watch). Renders the
 * shared shell with the workflow name, the one safe sentence the readiness
 * check produced, and a footer CTA that opens the recovery panel.
 */

export interface WorkflowBlockedEmailProps {
  workflowName?: string;
  /** The readiness verdict's safe sentence. Never raw provider text. */
  message?: string;
  /** Stable machine code, shown small so a support thread can quote it. */
  code?: string;
  /** Deep link to the workflow page with the recovery panel open. */
  workflowUrl?: string;
  logoUrl?: string;
  createdAt?: string;
  timezone?: string;
}

export const WorkflowBlockedEmail = ({
  workflowName = "Morning inbox sweep",
  message = "Gmail is not connected. Connect it to let this workflow run.",
  code = "missing_capability",
  workflowUrl = "http://localhost:3000/workflows/morning-inbox-sweep?workflow_recovery=1",
  logoUrl,
  createdAt = new Date().toISOString(),
  timezone,
}: WorkflowBlockedEmailProps): React.ReactElement => {
  return (
    <EmailShell
      previewText={`${workflowName} is blocked — ${message}`}
      logoUrl={logoUrl}
      createdAt={createdAt}
      timezone={timezone}
      ctaUrl={workflowUrl}
      ctaLabel="Fix in Alfred"
    >
      <h1 style={bodyStyles.heading}>{workflowName} is blocked</h1>
      <p style={bodyStyles.paragraph}>
        Alfred could not run this workflow. It stays paused until you fix the problem below, and
        nothing runs in the meantime.
      </p>
      <p
        style={{
          ...bodyStyles.paragraph,
          background: "#fff7ed",
          border: "1px solid #fed7aa",
          borderRadius: "8px",
          padding: "12px 16px",
        }}
      >
        <strong style={bodyStyles.strong}>{message}</strong>
      </p>
      <p style={{ ...bodyStyles.muted, margin: "16px 0 0 0", fontSize: "12px" }}>Code {code}</p>
    </EmailShell>
  );
};

WorkflowBlockedEmail.PreviewProps = {
  logoUrl: "http://localhost:3000/images/logo/alfred-logo-email.png",
} satisfies WorkflowBlockedEmailProps;

export default WorkflowBlockedEmail;
