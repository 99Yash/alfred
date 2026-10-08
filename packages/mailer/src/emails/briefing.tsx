import { Markdown } from "@react-email/components";
import { render } from "@react-email/render";
import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/** The briefing email. The agent writes markdown; this template owns all styling. */

export interface BriefingEmailProps {
  /** Body markdown. */
  content?: string;
  /** ISO generation time. */
  createdAt?: string;
  /** IANA zone for the footer time. Defaults to UTC. */
  timezone?: string | undefined;
  /** Absolute logo URL. No logo when omitted. */
  logoUrl?: string;
  /** Inbox preview line. */
  previewText?: string;
  /** Adds a footer CTA button. */
  ctaUrl?: string;
  /** Defaults to "Open Alfred". */
  ctaLabel?: string;
}

const DEFAULT_CONTENT = `Good morning, Yash.

Quiet overnight. Nothing in the priority buckets that needs you before your first block.

Have a good one.`;

export const BriefingEmail = ({
  content = DEFAULT_CONTENT,
  createdAt = new Date().toISOString(),
  timezone,
  logoUrl,
  previewText = "Your briefing is ready",
  ctaUrl,
  ctaLabel = "Open Alfred",
}: BriefingEmailProps): React.ReactElement => {
  return (
    <EmailShell
      previewText={previewText}
      logoUrl={logoUrl}
      createdAt={createdAt}
      timezone={timezone}
      ctaUrl={ctaUrl}
      ctaLabel={ctaLabel}
    >
      <Markdown
        markdownCustomStyles={{
          p: bodyStyles.paragraph,
          bold: bodyStyles.strong,
          ul: {
            ...bodyStyles.paragraph,
            paddingLeft: "20px",
          },
          ol: {
            ...bodyStyles.paragraph,
            paddingLeft: "20px",
          },
          li: { color: "#374151", margin: "0 0 8px 0" },
          link: bodyStyles.link,
        }}
      >
        {content}
      </Markdown>
    </EmailShell>
  );
};

BriefingEmail.PreviewProps = {
  previewText: "Your morning briefing is ready",
  ctaUrl: "http://localhost:3000/chat",
  logoUrl: "http://localhost:3000/images/logo/alfred-logo-email.png",
} satisfies BriefingEmailProps;

export default BriefingEmail;

/** Render to HTML. */
export const renderBriefingEmail = (props: BriefingEmailProps): Promise<string> =>
  render(<BriefingEmail {...props} />);
