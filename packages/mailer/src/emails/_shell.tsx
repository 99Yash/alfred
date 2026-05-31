import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Tailwind,
} from "@react-email/components";
import * as React from "react";

/**
 * The shared email shell. Adapted from Dimension's briefing templates: a
 * single white card holding a logo + arbitrary body content, with a footer
 * carrying the generation timestamp and an optional dark pill CTA button.
 *
 * Every Alfred email (briefing, approval, skill-documented) renders through
 * this shell so brand, spacing, logo placement, and footer stay identical.
 * Bodies differ — markdown prose, a fields table, a preview block — but the
 * frame does not.
 *
 * Inline styles only, no external CSS: email clients (Gmail especially) strip
 * <style> blocks. The one <style> we ship is a mobile media query for the
 * footer — progressive enhancement, safe to drop.
 */

export interface EmailShellProps {
  /** Short line shown in the inbox preview / snippet. */
  previewText?: string;
  /** Absolute URL to the logo image. Hidden when omitted. */
  logoUrl?: string;
  /** ISO timestamp shown in the footer ("Generated on …"). Defaults to now. */
  createdAt?: string;
  /** IANA timezone (e.g. "America/New_York") for the footer timestamp. Falls back to UTC. */
  timezone?: string;
  /** When set, renders a pill CTA button in the footer. */
  ctaUrl?: string;
  /** Label for the CTA button. Defaults to "Open Alfred". */
  ctaLabel?: string;
  /** Card body. */
  children?: React.ReactNode;
}

/**
 * Shared body styles so non-markdown bodies match the briefing's prose.
 * All values are strings (incl. `fontWeight: "600"`): React inline styles
 * accept strings, and `<Markdown markdownCustomStyles>` (md-to-react-email)
 * runs `value.includes(...)` on every value — a numeric weight crashes it.
 */
export const bodyStyles = {
  heading: {
    color: "#111827",
    fontSize: "18px",
    fontWeight: "600",
    lineHeight: "1.4",
    margin: "0 0 12px 0",
  },
  paragraph: {
    color: "#374151",
    fontSize: "15px",
    lineHeight: "1.7",
    margin: "0 0 20px 0",
  },
  strong: { color: "#111827", fontWeight: "600" },
  link: { color: "#6366f1", textDecoration: "underline" },
  muted: { color: "#9ca3af", fontSize: "13px", lineHeight: "1.6" },
} as const;

export const formatDate = (iso: string, timeZone?: string): string => {
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

export const EmailShell = ({
  previewText = "A new update from Alfred",
  logoUrl,
  createdAt = new Date().toISOString(),
  timezone,
  ctaUrl,
  ctaLabel = "Open Alfred",
  children,
}: EmailShellProps) => {
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
              {children}
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

export default EmailShell;
