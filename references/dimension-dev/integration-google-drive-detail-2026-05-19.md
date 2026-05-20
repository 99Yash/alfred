# Dimension Google Drive integration detail - 2026-05-19

Captured from the authenticated Chrome tab at `https://dimension.dev/integrations/google_drive` on 2026-05-19. This fills the integration-detail gap that the earlier generic Gmail/Slack notes did not cover.

This file is sanitized. The live page contained a private connected account and workspace domain; preserve the layout and behavior, not the literal account strings. A full-page screenshot was captured locally at `/private/tmp/dimension-google-drive-integration.png` for short-term visual verification, but it is not checked in because it contains private identifiers.

## Evidence

- URL/title: `/integrations/google_drive`, `Google Drive Integration - Dimension`.
- Viewport: `1728 x 992`, device scale factor `2`.
- App shell: same authenticated shell as `/chat`, with shutdown notice, left sidebar, and route content; no right weather rail.
- Chrome a11y tree exposed the full route structure, including `All integrations`, `Google Drive`, `Add Account`, connected account rows, Google setup cards, capabilities, and overview content.
- Computed styles were collected from the live DOM. Source maps were not needed for this pass; this is a rebuild contract for Alfred primitives.

## Route Skeleton

```tsx
<AppShell>
  <RouteMain>
    <IntegrationDetail className="mx-auto w-full max-w-[672px] py-24">
      <BackLink href="/integrations">All integrations</BackLink>

      <Header>
        <ProviderIcon provider="google_drive" />
        <div>
          <p>Google Drive</p>
          <p>Access and manage Google Drive files</p>
        </div>
        <Button variant="primary">Add Account</Button>
      </Header>

      <ConnectedAccounts />
      <TrustNotice />
      <RelatedGoogleSetup />
      <Capabilities />
      <Overview />
    </IntegrationDetail>
  </RouteMain>
</AppShell>
```

The main content column observed from the live page is roughly `672px` wide and centered. Header content starts near `x=644`; the route title text starts near `x=696`, leaving room for the provider icon. The primary action sits on the far right of the same row.

## Header

| Element | Observed contract |
| --- | --- |
| Back link | `All integrations`, real link back to `/integrations`, placed above provider header. |
| Provider title | `14px / 20px`, weight `500`, near-white text. |
| Description | Muted text under title; copy: `Access and manage Google Drive files`. |
| Add Account | Primary purple frost pill, about `124 x 40`, `rounded-full`, `px-4 py-2`, `15px / 22.5px`, gradient `rgb(93,68,223) -> rgb(79,55,203)`, inset white glow. |

Radix/Alfred target: `Add Account` opens a Radix `Dialog` when scopes/account confirmation is needed. Focus returns to the trigger after close.

## Connected Accounts

Live copy/shape:

- Section heading: `Connected`.
- A compact table-like area with columns `Connected`, `Date`, and `Status`.
- Connected account row shows the account identity, workspace/domain, connect date, active status, and a red `Disconnect` pill.
- The red action uses the same frost button base with destructive background `rgb(220,38,38)` and `rounded-full`.

Alfred build:

```tsx
<section aria-labelledby="connected-accounts-title">
  <h2 id="connected-accounts-title">Connected</h2>
  <table>
    <thead>
      <tr>
        <th>Connected</th>
        <th>Date</th>
        <th>Status</th>
        <th><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><AccountIdentity /></td>
        <td>{connectedAt}</td>
        <td><StatusDot label="Active" /></td>
        <td><Button variant="destructive">Disconnect</Button></td>
      </tr>
    </tbody>
  </table>
</section>
```

Use a semantic table for keyboard and screen-reader clarity even if the visual surface remains border-light and card-like. `Disconnect` should open Radix `AlertDialog`; do not disconnect immediately from the table button.

## Trust Notice

Live copy:

- Title: `Your data is indexed & encrypted`.
- Body: `Your data is indexed and encrypted at rest. We never train AI models on your data or share it with third parties.`

This is not a marketing banner; it sits inline in the detail content below the connected-account row. Keep it visually quiet: no oversized card, no icon-heavy treatment. A small lock/shield icon is acceptable if it matches other route metadata rows.

## Complete Your Google Setup

This section is specific to the Google Drive detail page and was missing from the previous generic integration-detail notes.

Live copy:

- Heading: `Complete your Google Setup`.
- Description: `To access Google Docs, Slides, and Sheets, you must also connect the respective integrations.`
- Rows:
  - `Google Docs` - `Create and edit Google Docs` - `Manage`
  - `Google Sheets` - `Work with Google Sheets` - `Manage`
  - `Google Slides` - `Create and edit Google Slides` - `Manage`

Observed row style:

| Element | Observed contract |
| --- | --- |
| Row button | About `639 x 65`, `p-3`, `rounded-2xl`, transparent base, hover/focus fill `#181818`. |
| Text | Row foreground starts muted `rgb(160,160,160)` and lifts on hover/focus. |
| Layout | Provider icon and two-line label on the left; `Manage` affordance on the right. |

Important accessibility correction for Alfred: the live a11y tree exposed each related integration row as a button containing a nested `Manage` button. Avoid nested interactive elements. Make each row either:

- one `<Link>` or `<button>` with the whole accessible name, including `Manage`, or
- a non-interactive row with one trailing `Button`.

Preferred Alfred structure:

```tsx
<section aria-labelledby="google-setup-title">
  <h2 id="google-setup-title">Complete your Google Setup</h2>
  <p>To access Google Docs, Slides, and Sheets...</p>
  <RelatedIntegrationRow provider="google_docs" actionLabel="Manage" />
  <RelatedIntegrationRow provider="google_sheets" actionLabel="Manage" />
  <RelatedIntegrationRow provider="google_slides" actionLabel="Manage" />
</section>
```

## Capabilities

Live capability labels:

- `Read Files`
- `Upload Files`
- `Download Files`
- `Create Folders`
- `Share Files`
- `Search Files`
- `Manage Permissions`

These are user-facing capability names, not raw OAuth scope strings. Keep them as readable chips/list rows. If Alfred stores provider scopes separately, map scopes to these labels at the provider-metadata layer.

## Overview

Live copy:

- `Connect your Google Drive to Dimension for comprehensive file management. Access, upload, download, and organize your files directly from your AI assistant.`
- Subheading: `Smart File Operations`
- Body: `Dimension can help you find specific files, organize your Drive, share documents with team members, and even analyze file contents to answer questions about your documents.`

Keep the overview after capabilities. It is explanatory reference text, not the hero. The route's actionable hierarchy is: account connection, connected state, related Google setup, capabilities, then overview.

## Keyboard And Accessibility Contract

- `All integrations` is the first route-local focus target after the app shell.
- `Add Account` is a real button with visible focus and opens a modal/dialog when implemented.
- Connected accounts are navigable as a semantic table or labelled row group.
- `Disconnect` opens an `AlertDialog` with confirmation and focus trapping.
- Related Google setup rows must not nest buttons inside buttons.
- Each related provider row has a unique accessible name, e.g. `Google Docs, Create and edit Google Docs, Manage`.
- Status text should not rely on color only; use visible `Active` text plus an optional status dot.
- Private account identifiers are never hardcoded in demos, screenshots, or docs.

## Alfred Implementation Notes

- Add a provider detail route such as `apps/web/src/routes/integrations.$provider.tsx`.
- Share provider metadata with `/integrations`, the composer `@` mention menu, and the connect-tools modal.
- Add `relatedProviders` metadata for Google Drive: Docs, Sheets, Slides.
- Use existing `Button`, `Card`/row primitives, and Radix `Dialog`/`AlertDialog`; no new visual system is needed.
- Preserve route width and quiet management-page density. This is not a frosted dashboard card page; the only loud control is the primary `Add Account` pill.
