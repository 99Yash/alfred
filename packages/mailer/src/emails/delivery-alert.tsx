import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/**
 * The "deliveries stopped" email (ADR-0100). Sent when an integration the user
 * connected has stopped delivering events and only the user can restore it.
 *
 * A source that produces events only while it is healthy sends nothing when it
 * breaks, so nothing in the app can notice on the user's behalf. This email is
 * the push half of the alert: the banner waits for the user to open Alfred,
 * and this does not.
 *
 * `reason` is the source's own health verdict, one sentence. The alert surface
 * rule already refused every verdict written for an operator, so what reaches
 * this template names the account, never a deployment fact.
 */

export interface DeliveryAlertEmailProps {
  /** Display name of the integration that stopped delivering. */
  integrationName?: string;
  /** The health check's one sentence. Never raw provider text. */
  reason?: string;
  /** Deep link to the integration page, where the connect control lives. */
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
