import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Img,
  Markdown,
  Preview,
  Tailwind,
} from "@react-email/components";
import { render } from "@react-email/render";
import * as React from "react";

/**
 * The daily-briefing email shell. Adapted from Dimension's
 * `evening-briefing` / `morning-briefing-2` templates: a single white
 * card holding a logo + the briefing body, with a footer carrying the
 * generation timestamp and an optional CTA button.
 *
 * The body is **markdown** — the briefing agent emits markdown (not HTML),
 * and this template owns all styling. That keeps the model's contract
 * simple (write prose) and the visual design in one place. `<Markdown>`
 * renders it to email-safe HTML with the inline styles below.
 *
 * Inline styles only, no external CSS: email clients (Gmail especially)
 * strip <style> blocks. The one <style> we do ship is a mobile media
 * query for the footer — progressive enhancement, safe to drop.
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

const formatDate = (iso: string, timeZone?: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    // Render in the user's timezone with an explicit label so the footer
    // isn't silently in the (usually UTC) server timezone. Falls back to UTC.
    timeZone: timeZone ?? "UTC",
    timeZoneName: "short",
  });
};

export const BriefingEmail = ({
  content = DEFAULT_CONTENT,
  createdAt = new Date().toISOString(),
  timezone,
  logoUrl,
  previewText = "Your briefing is ready",
  ctaUrl,
  ctaLabel = "Open Alfred",
}: BriefingEmailProps) => {
  return (
    <Html>
      <Head>
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @media only screen and (max-width: 480px) {
                .footer-cell { display: block !important; width: 100% !important; text-align: left !important; padding-bottom: 12px !important; }
                .main-container { padding: 24px 12px !important; }
                .content-card { padding: 24px 20px !important; }
              }
            `,
          }}
        />
      </Head>
      <Preview>{previewText}</Preview>
      <Tailwind>
        <Body
          style={{
            margin: 0,
            padding: 0,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
            backgroundColor: "#f9fafb",
          }}
        >
          <Container
            className="main-container"
            style={{ maxWidth: "600px", margin: "0 auto", padding: "40px 20px" }}
          >
            {/* Content card */}
            <div
              className="content-card"
              style={{
                backgroundColor: "#ffffff",
                borderRadius: "8px",
                padding: "32px 32px",
                boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              }}
            >
              {logoUrl ? (
                <Img src={logoUrl} alt="Alfred" height="48" style={{ marginBottom: "24px" }} />
              ) : null}
              <Markdown
                markdownCustomStyles={{
                  p: {
                    color: "#374151",
                    fontSize: "15px",
                    lineHeight: "1.7",
                    margin: "0 0 20px 0",
                  },
                  bold: { color: "#111827", fontWeight: "600" },
                  ul: {
                    color: "#374151",
                    fontSize: "15px",
                    lineHeight: "1.7",
                    margin: "0 0 20px 0",
                    paddingLeft: "20px",
                  },
                  ol: {
                    color: "#374151",
                    fontSize: "15px",
                    lineHeight: "1.7",
                    margin: "0 0 20px 0",
                    paddingLeft: "20px",
                  },
                  li: { color: "#374151", margin: "0 0 8px 0" },
                  link: { color: "#6366f1", textDecoration: "underline" },
                }}
              >
                {content}
              </Markdown>
            </div>

            {/* Footer: timestamp + optional CTA */}
            <table cellPadding="0" cellSpacing="0" style={{ width: "100%", marginTop: "24px" }}>
              <tbody>
                <tr>
                  <td className="footer-cell" style={{ verticalAlign: "middle" }}>
                    <span style={{ color: "#9ca3af", fontSize: "13px" }}>
                      Generated on {formatDate(createdAt, timezone)}
                    </span>
                  </td>
                  {ctaUrl ? (
                    <td
                      className="footer-cell"
                      style={{ textAlign: "right", verticalAlign: "middle" }}
                    >
                      <Button
                        href={ctaUrl}
                        style={{
                          backgroundColor: "#111827",
                          borderRadius: "9999px",
                          color: "#ffffff",
                          fontSize: "14px",
                          fontWeight: "500",
                          padding: "12px 24px",
                          textDecoration: "none",
                        }}
                      >
                        {ctaLabel}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              </tbody>
            </table>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

BriefingEmail.PreviewProps = {
  previewText: "Your morning briefing is ready",
  ctaUrl: "http://localhost:3000/chat/new",
  logoUrl: "http://localhost:3000/images/logo/alfred-logo.svg",
} as BriefingEmailProps;

export default BriefingEmail;

/** Render the briefing email to an HTML string for sending. */
export const renderBriefingEmail = (props: BriefingEmailProps): Promise<string> =>
  render(<BriefingEmail {...props} />);
