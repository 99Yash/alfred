import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/**
 * Sent when a connection breaks and only the user can fix it (ADR-0100). The in-app banner waits
 * for the user to open Alfred; this does not. A model writes the headline and the body from the
 * connection's facts (ADR-0100 amendment 2026-10-28, revised); this template owns the styling,
 * the name on the button, and the link.
 */

export interface DeliveryAlertEmailProps {
  /** The model's headline. The sender also uses it as the subject. */
  headline?: string;
  /** The model's body, as plain paragraphs split on a blank line. Empty renders none. */
  body?: string;
  /** Integration display name, or an MCP connection's label. Names the button. */
  name?: string;
  /** Where the button goes. */
  url?: string;
  logoUrl?: string;
  createdAt?: string;
  timezone?: string | undefined;
}

export const DeliveryAlertEmail = ({
  headline = "GitHub stopped sending me activity",
  body = "The GitHub App installation for your account is no longer active, so new pull requests and reviews stopped reaching me on the 22nd.\n\nOne reconnect fixes it.",
  name = "GitHub",
  url = "http://localhost:3000/integrations/github",
  logoUrl,
  createdAt = new Date().toISOString(),
  timezone,
}: DeliveryAlertEmailProps): React.ReactElement => {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return (
    <EmailShell
      previewText={headline}
      logoUrl={logoUrl}
      createdAt={createdAt}
      timezone={timezone}
      ctaUrl={url}
      ctaLabel={`Reconnect ${name}`}
    >
      <h1 style={bodyStyles.heading}>{headline}</h1>
      {paragraphs.map((paragraph) => (
        <p key={paragraph} style={bodyStyles.paragraph}>
          {paragraph}
        </p>
      ))}
    </EmailShell>
  );
};

DeliveryAlertEmail.PreviewProps = {
  logoUrl: "http://localhost:3000/images/logo/alfred-logo-email.png",
} satisfies DeliveryAlertEmailProps;

export default DeliveryAlertEmail;
