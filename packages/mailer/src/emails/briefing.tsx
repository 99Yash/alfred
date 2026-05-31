import { Markdown } from "@react-email/components";
import { render } from "@react-email/render";
import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/**
 * The daily-briefing email. A markdown body rendered inside the shared
 * {@link EmailShell} (logo + white card + footer timestamp/CTA).
 *
 * The body is **markdown** — the briefing agent emits markdown (not HTML),
 * and the template owns all styling. That keeps the model's contract simple
 * (write prose) and the visual design in one place. `<Markdown>` renders it
 * to email-safe HTML with the inline styles below.
 */

export interface BriefingEmailProps {
  /** Markdown for the body content card. */
  content?: string;
  /** ISO timestamp of when the briefing was generated. */
  createdAt?: string;
  /** IANA timezone (e.g. "America/New_York") for the footer timestamp. Falls back to UTC. */
  timezone?: string;
  /** Absolute URL to the logo image. Hidden when omitted. */
  logoUrl?: string;
  /** Short line shown in the inbox preview / snippet. */
  previewText?: string;
  /** When set, renders a pill CTA button in the footer. */
  ctaUrl?: string;
  /** Label for the CTA button. Defaults to "Open Alfred". */
  ctaLabel?: string;
}

const DEFAULT_CONTENT = `Good morning, Yash.

Quiet overnight — nothing in the priority buckets that needs you before your first block. The **Redis URI** thread from yesterday is still the one open loop; no new replies since the evening briefing.

A couple of newsletters and one calendar invite landed, both triaged out. You're clear to start on whatever you'd planned.

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
  ctaUrl: "http://localhost:3000/chat/new",
  logoUrl: "http://localhost:3000/images/logo/alfred-logo-email.png",
} as BriefingEmailProps;

export default BriefingEmail;

/** Render the briefing email to an HTML string for sending. */
export const renderBriefingEmail = (props: BriefingEmailProps): Promise<string> =>
  render(<BriefingEmail {...props} />);
