import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalSection } from "~/components/legal/legal-page";

/**
 * Public terms of service — `/terms-of-service`. Linked from the landing
 * footer and registered on the OAuth consent screen, so it must be reachable
 * without authentication. Renders chromeless via the `chromeless` set in
 * `app-shell.tsx`.
 */
export const Route = createFileRoute("/terms-of-service")({
  component: TermsOfService,
});

const CONTACT = "yashgouravkar@gmail.com";

function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" effectiveDate="May 30, 2026">
      <p>
        These terms govern your use of Alfred (&ldquo;the Service&rdquo;). By connecting your
        account and using the Service, you agree to them. If you do not agree, do not use the
        Service.
      </p>

      <LegalSection heading="The Service">
        <p>
          Alfred is a personal AI assistant that connects to your email, calendar, and related tools
          to triage your inbox, brief you, prepare you for meetings, and perform tasks you direct it
          to. Alfred acts on your behalf using the permissions you grant.
        </p>
      </LegalSection>

      <LegalSection heading="Your responsibilities">
        <ul className="ml-5 list-disc space-y-1.5 text-neutral-400">
          <li>You must own, or be authorized to connect, the accounts you link to Alfred.</li>
          <li>
            You are responsible for actions taken through Alfred at your direction — including
            messages sent and documents created or modified.
          </li>
          <li>
            You agree not to use the Service to violate any law or the terms of the third-party
            services you connect (such as Google).
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="AI-generated output">
        <p>
          Alfred uses AI models to draft, summarize, and decide. Output can be inaccurate or
          incomplete. You are responsible for reviewing anything Alfred produces before relying on
          it or sending it. Actions that send mail or modify data are surfaced for your approval
          where applicable.
        </p>
      </LegalSection>

      <LegalSection heading="Privacy">
        <p>
          Your use of the Service is also governed by our{" "}
          <a href="/privacy-policy" className="underline hover:text-white">
            Privacy Policy
          </a>
          , which describes what data we access and how we handle it.
        </p>
      </LegalSection>

      <LegalSection heading="Availability & changes">
        <p>
          The Service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We
          may change, suspend, or discontinue any part of it at any time. We may update these terms;
          continued use after a change constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection heading="Disclaimer & liability">
        <p>
          To the fullest extent permitted by law, the Service is provided without warranties of any
          kind, and we are not liable for any indirect, incidental, or consequential damages arising
          from your use of the Service.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about these terms? Email{" "}
          <a href={`mailto:${CONTACT}`} className="underline hover:text-white">
            {CONTACT}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
