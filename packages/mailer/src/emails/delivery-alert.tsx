import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/**
 * Sent when a connected integration stops delivering events and only the user
 * can fix it (ADR-0100). The in-app banner waits for the user to open Alfred; this does not.
 */

export interface DeliveryAlertEmailProps {
  /** Integration display name. */
  integrationName?: string;
  /** One sentence from the health check, written for the user. Never raw provider text. */
  reason?: string;
  /** Link to the integration page. */
  integrationUrl?: string;
  logoUrl?: string;
  createdAt?: string;
  timezone?: string;
}

export const DeliveryAlertEmail = ({
  integrationName = "GitHub",
  reason = "the GitHub App installation for this account is no longer active",
  integrationUrl = "http://localhost:3000/integrations/github",
  logoUrl,
  createdAt = new Date().toISOString(),
  timezone,
}: DeliveryAlertEmailProps): React.ReactElement => {
  return (
    <EmailShell
      previewText={`Alfred stopped receiving ${integrationName} activity`}
      logoUrl={logoUrl}
      createdAt={createdAt}
      timezone={timezone}
      ctaUrl={integrationUrl}
      ctaLabel={`Reconnect ${integrationName}`}
    >
      <h1 style={bodyStyles.heading}>Alfred stopped receiving {integrationName} activity</h1>
      <p style={bodyStyles.paragraph}>
        Nothing from {integrationName} has reached Alfred since the connection broke. Anything that
        happened there in the meantime is missing, and it stays missing until you reconnect.
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
        <strong style={bodyStyles.strong}>{reason}.</strong>
      </p>
    </EmailShell>
  );
};

DeliveryAlertEmail.PreviewProps = {
  logoUrl: "http://localhost:3000/images/logo/alfred-logo-email.png",
} satisfies DeliveryAlertEmailProps;

export default DeliveryAlertEmail;
