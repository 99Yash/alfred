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
 * The frame every Alfred email uses: logo, white card, footer with time and an optional CTA.
 * Use inline styles: Gmail strips `<style>`. The one `<style>` is a mobile
 * footer tweak that clients may drop.
 */

export interface EmailShellProps {
  /** Inbox preview line. */
  previewText?: string | undefined;
  /** Absolute logo URL. No logo when omitted. */
  logoUrl?: string | undefined;
  /** ISO time for the footer. Defaults to now. */
  createdAt?: string | undefined;
  /** IANA zone for the footer time. Defaults to UTC. */
  timezone?: string | undefined;
  /** Adds a footer CTA button. */
  ctaUrl?: string | undefined;
  /** Defaults to "Open Alfred". */
  ctaLabel?: string | undefined;
  children?: React.ReactNode;
}

/**
 * Body styles shared with the briefing prose. Keep every value a string:
 * `<Markdown markdownCustomStyles>` calls `value.includes(...)`, so a number crashes it.
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

const formatDate = (iso: string, timeZone?: string): string => {
  const d = new Date(iso);

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
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
