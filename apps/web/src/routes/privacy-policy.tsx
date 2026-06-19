import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { LegalPage, LegalSection } from "~/components/legal/legal-page";

/**
 * Public privacy policy — `/privacy-policy`. Linked from the landing footer
 * and registered as the OAuth consent-screen privacy link, so it must be
 * reachable without authentication. Renders chromeless via the `chromeless`
 * set in `app-shell.tsx`.
 *
 * Written for Google OAuth verification: discloses exactly which Google user
 * data Alfred accesses, why, how it's stored and shared, and includes the
 * Limited Use statement required for sensitive/restricted Gmail, Calendar,
 * and Drive scopes.
 */
export const Route = createFileRoute("/privacy-policy")({
  head: () => pageMeta({ title: "Privacy Policy", path: "/privacy-policy" }),
  component: PrivacyPolicy,
});

const CONTACT = "yashgouravkar@gmail.com";

export function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" effectiveDate="May 30, 2026">
      <p>
        Alfred (&ldquo;Alfred&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is a personal AI assistant
        that connects to your email, calendar, and related Google services to triage your inbox,
        brief you each morning, and prepare you for meetings on your behalf. This policy explains
        what data Alfred accesses, why, and how it is handled. By connecting your account you agree
        to the practices described here.
      </p>

      <LegalSection heading="Google user data we access">
        <p>
          When you connect your Google account, Alfred requests only the OAuth scopes needed for the
          features you enable. Depending on what you turn on, this can include:
        </p>
        <ul className="ml-5 list-disc space-y-1.5 text-neutral-400">
          <li>
            <strong className="text-neutral-200">Gmail</strong>: read messages and metadata to
            triage your inbox, apply labels, and prepare draft replies; send mail you explicitly
            approve.
          </li>
          <li>
            <strong className="text-neutral-200">Google Calendar</strong>: read events to build your
            daily briefing and meeting prep.
          </li>
          <li>
            <strong className="text-neutral-200">Drive, Docs, Sheets &amp; Slides</strong>: read and
            (where you enable it) write files you point Alfred at, to summarize, draft, or update
            documents on your request.
          </li>
          <li>
            <strong className="text-neutral-200">Basic profile</strong>: your name and email
            address, to identify your account.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="How we use it">
        <p>
          Google user data is used solely to provide Alfred&rsquo;s features to you: inbox triage,
          morning briefings, meeting prep, drafting, and the tasks you ask it to perform. We do not
          use your Google data for advertising, and we do not sell it. We do not use your Google
          user data to train generalized AI or machine-learning models.
        </p>
      </LegalSection>

      <LegalSection heading="Limited Use disclosure">
        <p className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 text-neutral-300">
          Alfred&rsquo;s use and transfer of information received from Google APIs to any other app
          will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </LegalSection>

      <LegalSection heading="AI processing & sharing">
        <p>
          To answer your requests, relevant content (for example, the text of an email being
          triaged) may be sent to third-party AI model providers that process it on our behalf under
          their own confidentiality and data-handling terms, and that do not use it to train their
          models. We share Google user data only with such service providers as needed to run the
          features you use, when required by law, or with your explicit direction. We never sell
          your data or transfer it for advertising.
        </p>
      </LegalSection>

      <LegalSection heading="Storage & security">
        <p>
          OAuth tokens and the data Alfred needs to operate are stored in our managed database with
          access restricted to the application. Tokens are used only to call Google APIs on your
          behalf and are refreshed automatically. We retain data only as long as needed to provide
          the service.
        </p>
      </LegalSection>

      <LegalSection heading="Retention & deletion">
        <p>
          You can disconnect Google at any time from Alfred&rsquo;s integrations settings, or revoke
          Alfred&rsquo;s access directly from your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white"
          >
            Google Account permissions
          </a>
          . Disconnecting stops all future access and removes the stored tokens. To request deletion
          of any remaining associated data, email us at the address below.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about this policy or your data? Email{" "}
          <a href={`mailto:${CONTACT}`} className="underline hover:text-white">
            {CONTACT}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
