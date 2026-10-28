import { Markdown } from "@react-email/components";
import { render } from "@react-email/render";
import * as React from "react";
import { bodyStyles, EmailShell } from "./_shell";

/** The briefing email. The agent writes markdown; this template owns all styling. */

/**
 * One row below the prose: a connection that broke, and the action that restores it
 * (ADR-0100 amendment 2026-10-28, revised). The composer writes `text`; the sender owns the
 * name and the link, so a row with no text still renders.
 */
export interface BriefingBlockRow {
  /** Integration display name, or an MCP connection's label. */
  name: string;
  /** The composer's notice. `null` renders the name alone. */
  text: string | null;
  actionLabel: string;
  actionUrl: string;
}

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
  /** Broken connections. Rendered below the body; empty or absent renders nothing. */
  blockRows?: readonly BriefingBlockRow[];
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
  blockRows = [],
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
      {blockRows.length > 0 ? <BrokenConnectionBlock rows={blockRows} /> : null}
    </EmailShell>
  );
};

const BrokenConnectionBlock = ({
  rows,
}: {
  rows: readonly BriefingBlockRow[];
}): React.ReactElement => {
  return (
    <div
      style={{
        background: "#fff7ed",
        border: "1px solid #fed7aa",
        borderRadius: "8px",
        padding: "12px 16px",
        margin: "8px 0 0 0",
      }}
    >
      {rows.map((row) => (
        <p
          // Two MCP connections can share a label; the link names one connection.
          key={row.actionUrl}
          style={{ color: "#374151", fontSize: "14px", lineHeight: "1.6", margin: "0 0 4px 0" }}
        >
          {row.text ?? <strong style={bodyStyles.strong}>{row.name}</strong>}{" "}
          <a href={row.actionUrl} style={bodyStyles.link}>
            {row.actionLabel}
          </a>
        </p>
      ))}
    </div>
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
