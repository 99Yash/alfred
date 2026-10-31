import type { ReactNode } from "react";
import { LegalPage, LegalSection } from "~/components/legal/legal-page";

const CONTACT = "yashgouravkar@gmail.com";

const CLIENT_ID = "https://api.alfred.beauty/api/integrations/mcp/client-metadata";

const REDIRECT_URI = "https://api.alfred.beauty/api/integrations/mcp/callback";

/** Mirrors the live document at `CLIENT_ID` (`mcpOAuthClientConfiguration`). */
const CLIENT_METADATA = JSON.stringify(
  {
    client_id: CLIENT_ID,
    client_name: "Alfred",
    client_uri: "https://alfred.beauty/",
    redirect_uris: [REDIRECT_URI],
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  null,
  2,
);

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[13px] text-neutral-200">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-white/10 bg-white/5 p-4 font-mono text-[12.5px] leading-[1.6] text-neutral-200">
      {children}
    </pre>
  );
}

export function McpClientPage() {
  return (
    <LegalPage title="MCP Client" effectiveDate="October 29, 2026">
      <p>
        Alfred is a remote Model Context Protocol (MCP) client. It connects to hosted MCP servers
        for the user, reads their tool catalogs, and lets its agent call those tools. This page
        states what an MCP server operator sees when Alfred connects.
      </p>

      <LegalSection heading="Transport and protocol">
        <ul className="ml-5 list-disc space-y-1.5 text-neutral-400">
          <li>Transport: Streamable HTTP only.</li>
          <li>
            Protocol versions: <Code>2025-11-25</Code>, <Code>2025-06-18</Code>,{" "}
            <Code>2025-03-26</Code>, and <Code>2024-11-05</Code>. Alfred negotiates the version with
            the server.
          </li>
          <li>
            Alfred accepts only a public <Code>https</Code> endpoint. It refuses a host that
            resolves to a private or internal address. It checks each redirect, keeps MCP traffic on
            the origin of the endpoint, and does not replay a redirected <Code>POST</Code>.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Authorization">
        <p>Alfred implements the MCP authorization specification (2025-06-18 and later).</p>
        <ol className="ml-5 list-decimal space-y-1.5 text-neutral-400">
          <li>
            <strong className="text-neutral-200">Discovery.</strong> Alfred reads the protected
            resource metadata of the server (RFC 9728), then the authorization server metadata (RFC
            8414). OpenID Connect discovery is the fallback.
          </li>
          <li>
            <strong className="text-neutral-200">Client identity.</strong> If the authorization
            server supports client ID metadata documents, Alfred uses one. Otherwise Alfred uses
            dynamic client registration (RFC 7591) with the same metadata.
          </li>
          <li>
            <strong className="text-neutral-200">Authorization request.</strong> Alfred uses the
            authorization code grant with PKCE (<Code>S256</Code>). It refuses a server that does
            not support <Code>S256</Code>. It sends the <Code>resource</Code> parameter (RFC 8707)
            on the authorization request and on each token request, so each token is bound to one
            MCP server.
          </li>
          <li>
            <strong className="text-neutral-200">Callback.</strong> Each attempt is bound to a
            one-time <Code>state</Code> value. When the server supports it, Alfred checks the{" "}
            <Code>iss</Code> response parameter (RFC 9207).
          </li>
          <li>
            <strong className="text-neutral-200">Refresh.</strong> Alfred refreshes a token before
            it expires. It asks the user for consent again only when it has no usable refresh token.
          </li>
        </ol>
      </LegalSection>

      <LegalSection heading="Client metadata">
        <p>
          Alfred is a public client. It holds no client secret unless a server issues one at
          registration. This document is served at its own <Code>client_id</Code> URL:
        </p>
        <CodeBlock>{CLIENT_METADATA}</CodeBlock>
      </LegalSection>

      <LegalSection heading="Redirect URI">
        <CodeBlock>{REDIRECT_URI}</CodeBlock>
      </LegalSection>

      <LegalSection heading="Token storage">
        <p>
          Alfred encrypts each access token, refresh token, and client secret with AES-256-GCM
          before it stores the value. The key is held outside the database. Alfred has no plaintext
          fallback.
        </p>
      </LegalSection>

      <LegalSection heading="Tool calls">
        <ul className="ml-5 list-disc space-y-1.5 text-neutral-400">
          <li>The user must approve each call to an MCP tool that the user has not reviewed.</li>
          <li>
            The user can review a tool and remove that approval step. The review is bound to the
            exact tool schema. If the server changes the schema, the approval step comes back.
          </li>
          <li>
            When a server publishes a read-only resource, Alfred connects to that resource and not
            to the read-write one.
          </li>
          <li>The user can disconnect any MCP server at any time.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Email{" "}
          <a href={`mailto:${CONTACT}`} className="underline hover:text-white">
            {CONTACT}
          </a>
          . See also our{" "}
          <a href="/privacy-policy" className="underline hover:text-white">
            Privacy Policy
          </a>{" "}
          and{" "}
          <a href="/terms-of-service" className="underline hover:text-white">
            Terms of Service
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
