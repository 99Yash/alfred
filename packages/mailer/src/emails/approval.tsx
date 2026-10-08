import { render } from "@react-email/render";
import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/** Sent when a workflow pauses for the user to approve a risky action. */

export interface ApprovalEmailField {
  label: string;
  value: string;
}

export interface ApprovalEmailProps {
  /** Card heading, for example "Alfred wants to send an email". */
  heading?: string;
  /** Shown in the inbox preview and the intro. */
  riskTier?: string;
  /** Rows for the fields table. */
  fields?: ApprovalEmailField[];
  approvalUrl?: string;
  /** Run and staging ids, for debugging. */
  runId?: string;
  stagingId?: string;
  logoUrl?: string;
  createdAt?: string;
  timezone?: string;
}

const DEFAULT_FIELDS: ApprovalEmailField[] = [
  { label: "Workflow", value: "daily-briefing" },
  { label: "Tool", value: "gmail_send_email" },
  { label: "Risk", value: "high" },
  { label: "To", value: "investor@example.com" },
  { label: "Subject", value: "Re: follow-up" },
];

export const ApprovalEmail = ({
  heading = "Alfred wants to send an email",
  riskTier = "high",
  fields = DEFAULT_FIELDS,
  approvalUrl = "http://localhost:3000/approvals",
  runId = "run_demo",
  stagingId = "staging_demo",
  logoUrl,
  createdAt = new Date().toISOString(),
  timezone,
}: ApprovalEmailProps): React.ReactElement => {
  return (
    <EmailShell
      previewText={`[${riskTier}] ${heading} — review before it runs`}
      logoUrl={logoUrl}
      createdAt={createdAt}
      timezone={timezone}
      ctaUrl={approvalUrl}
      ctaLabel="Review in Alfred"
    >
      <h1 style={bodyStyles.heading}>{heading}</h1>
      <p style={bodyStyles.paragraph}>
        A workflow paused for your approval before taking this action.
      </p>
      <table
        cellPadding="0"
        cellSpacing="0"
        style={{ borderCollapse: "collapse", margin: "0 0 8px 0" }}
      >
        <tbody>
          {fields.map((f, i) => (
            <tr key={`${f.label}-${i}`}>
              <th
                align="left"
                style={{
                  padding: "6px 16px 6px 0",
                  color: "#6b7280",
                  fontWeight: 500,
                  fontSize: "14px",
                  verticalAlign: "top",
                  whiteSpace: "nowrap",
                }}
              >
                {f.label}
              </th>
              <td style={{ padding: "6px 0", color: "#111827", fontSize: "14px" }}>{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ ...bodyStyles.muted, margin: "16px 0 0 0", fontSize: "12px" }}>
        Run {runId} · staging {stagingId}
      </p>
    </EmailShell>
  );
};

ApprovalEmail.PreviewProps = {
  logoUrl: "http://localhost:3000/images/logo/alfred-logo-email.png",
} satisfies ApprovalEmailProps;

export default ApprovalEmail;

/** Render to HTML. */
export const renderApprovalEmail = (props: ApprovalEmailProps): Promise<string> =>
  render(<ApprovalEmail {...props} />);
