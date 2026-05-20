# Dimension integrations overall design - 2026-05-19

Captured from the authenticated Chrome session on 2026-05-19. This file consolidates the integration catalog and provider-detail system so Alfred can rebuild the whole family of pages from shared provider metadata rather than one-off screens.

Sampled live routes:

- `/integrations`
- `/integrations/google_drive`
- `/integrations/google_gmail`
- `/integrations/google_calendar`
- `/integrations/slack`
- `/integrations/linear`
- `/integrations/figma` - confirmed 404 for a coming-soon provider

Private account identifiers appeared on connected Google pages and are intentionally omitted. Preserve structure, state, and behavior; do not preserve literal account values.

## Design Thesis

The integration area is a quiet management surface:

- Catalog page: discover, search, and route into provider setup.
- Detail page: connect/manage accounts, explain trust posture, list plain-English capabilities, and show provider-specific overview text.
- No decorative dashboards, no nested cards, no hero treatment for connected providers.
- Frost/glass is reserved for button primitives and select banners; rows themselves are mostly transparent with hover fill.

The key implementation move is a single provider metadata model:

```ts
type IntegrationProvider = {
  id: string; // e.g. "google_drive", "google_gmail", "slack"
  name: string;
  category: "connected" | "apps" | "productivity" | "business" | "development" | "custom";
  description: string;
  status: "connected" | "available" | "coming_soon";
  actionLabel: "Manage" | "Connect" | "Coming Soon" | "Add Integration";
  capabilities?: string[];
  trustNotice?: { title: string; body: string };
  overview?: { body: string; subheading: string; subcopy: string };
  relatedProviders?: string[];
};
```

Use the same metadata for `/integrations`, provider detail pages, the composer `@` mention menu, and the connect-tools modal.

## Catalog Page

Live route: `/integrations`.

### Header And Search

- H1 `Integrations`, centered, shared secondary-route display style: `40px / 48px`, weight `500`, white-to-muted gradient text.
- Subtitle: `Connect the tools you want to use with Dimension.`
- Search input placeholder: `Search for integration`.
- Search is route-local filtering, not a command palette. It filters across provider name/description and preserves the same row component.
- Typing `slack` left rows for `Slack`, `Slack Bot`, and also semantically related tools like `Linear`, `Notion`, and `GitHub`; search matching is broader than exact provider-name contains.

### Category Order

Observed order:

1. `Connected`
2. `Apps`
3. `Productivity`
4. `Business`
5. `Development`
6. `Your Integrations`

Connected providers are promoted out of their natural category and grouped first. Do this by deriving a `connected` view, not by duplicating provider records.

### Provider Rows

Observed desktop geometry:

- Three-column grid for most sections.
- Connected rows: about `450 x 65`.
- Other sections: about `455 x 65`.
- Row class behavior: `p-3`, `rounded-2xl`, transparent base, hover/focus fill `#181818`.
- Text starts muted (`rgb(160,160,160)`) and lifts on hover/focus.
- Row content: provider icon, name, one-line description, trailing action label.

Action labels by state:

| State | Catalog action | Detail-page primary action |
| --- | --- | --- |
| Connected | `Manage` | `Add Account` |
| Available, not connected | `Connect` | `Connect` |
| Coming soon | `Coming Soon` | No detail route; route 404s if guessed directly |
| Custom/MCP | `Add Integration` | Custom setup route/dialog |

Accessibility correction for Alfred: Dimension exposes rows as a button containing a nested trailing button. Avoid nested interactive elements. Prefer one of:

- whole row is one `<Link>`/`<button>` with action text included in the accessible name, or
- non-interactive row with exactly one trailing button/link.

Recommended Alfred catalog DOM:

```tsx
<RoutePage>
  <PageHeader title="Integrations" subtitle="Connect the tools you want to use with Alfred." />
  <SearchInput value={query} onChange={setQuery} placeholder="Search for integration" />

  {sections.map((section) => (
    <section aria-labelledby={`${section.id}-title`}>
      <h2 id={`${section.id}-title`}>{section.label}</h2>
      <div className="grid gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
        {section.providers.map((provider) => (
          <IntegrationRow provider={provider} />
        ))}
      </div>
    </section>
  ))}
</RoutePage>
```

## Catalog Provider Inventory

Observed rows:

| Section | Providers |
| --- | --- |
| Connected | Google Drive, Google Sheets, Google Slides, Google Docs, Google Calendar, Gmail, GitHub |
| Apps | iMessage, Slack Bot |
| Productivity | Slack, Granola, Linear, Notion, Dropbox, Asana, Figma |
| Business | HubSpot, Airtable, Ramp, Mercury, Stripe, Intercom |
| Development | Sentry, PostHog, Supabase, Vercel, Railway, Better Stack, Cloudflare, Databricks, Netlify |
| Your Integrations | MCP Server |

Coming-soon rows observed in the catalog: `Figma`, `Intercom`, `Better Stack`, `Cloudflare`, `Databricks`, `Netlify`. Direct navigation to `/integrations/figma` returned the app's 404 page, so coming-soon rows should not expose an active detail route.

Provider route IDs are snake_case and sometimes namespaced:

- Gmail: `/integrations/google_gmail`
- Google Calendar: `/integrations/google_calendar`
- Google Drive: `/integrations/google_drive`
- Slack: `/integrations/slack`
- Linear: `/integrations/linear`

## Provider Detail Template

Shared structure from Google Drive, Gmail, Google Calendar, Slack, and Linear:

```tsx
<IntegrationDetail>
  <BackLink href="/integrations">All integrations</BackLink>

  <Header>
    <ProviderIcon />
    <div>
      <h1>{provider.name}</h1>
      <p>{provider.description}</p>
    </div>
    <Button variant="primary">{connected ? "Add Account" : "Connect"}</Button>
  </Header>

  <ConnectedAccounts provider={provider} />
  <TrustNotice {...provider.trustNotice} />
  {provider.relatedProviders?.length ? <RelatedProviderSetup /> : null}
  <Capabilities labels={provider.capabilities} />
  <Overview {...provider.overview} />
</IntegrationDetail>
```

Observed content column is roughly `672px` wide and centered inside the authenticated app shell. The detail route has no right weather rail.

### Header

- Back link: `All integrations`.
- Provider title: `14px / 20px`, weight `500`, near-white.
- Description: muted line under title.
- Primary action: purple frost pill, `rounded-full`, `px-4 py-2`, `15px / 22.5px`, gradient `rgb(93,68,223) -> rgb(79,55,203)`, inset white glow.
- Connected providers use `Add Account`, implying multi-account support.
- Unconnected providers use `Connect`.

### Account State Row

Connected Google pages:

- Section heading `Connected`.
- Columns: `Connected`, `Date`, `Status`.
- Account row shows identity/domain, connect date, `Active`, and `Disconnect`.
- `Disconnect` is a destructive red frost pill.

Unconnected Slack/Linear pages:

- Same columns.
- `Connected` and `Date` display `-`.
- `Status` displays `Not connected`.
- No `Disconnect` action.

Alfred should implement this as a semantic table or labelled row group. `Disconnect` should open a Radix `AlertDialog`.

### Trust Notice

Two trust patterns observed:

- Connected Google/Gmail/Calendar/Drive/Linear style: `Your data is indexed & encrypted` with body explaining encryption at rest and no model training.
- Slack style: `Your data is safe` with provider-specific copy: data stays in Slack's database and is accessed on command.

Keep this inline and quiet. It is a trust row, not a marketing card.

### Capabilities

Capabilities are plain-English, user-facing labels. They are not OAuth scopes.

Sampled capability sets:

| Provider | Capabilities |
| --- | --- |
| Google Drive | Read Files, Upload Files, Download Files, Create Folders, Share Files, Search Files, Manage Permissions |
| Gmail | Read Emails, Compose Emails, Send Emails, Reply to Emails, Manage Labels, Search Conversations, Handle Attachments |
| Google Calendar | Read Events, Create Events, Update Events, Delete Events, Check Availability, Manage Attendees, Handle Recurring Events |
| Slack | Send Messages, Read Messages, Create Channels, Manage Channels, Fetch Unread Messages, Thread Management, File Sharing |
| Linear | Create Issues, Update Issues, Delete Issues, Manage Teams, Track Milestones, Organize Projects, Assign Tasks |

These labels should map to Alfred provider/tool capabilities. They are the public-language layer between OAuth scopes and agent tools.

### Overview

Overview sits after capabilities and follows a predictable pattern:

- One paragraph: `Connect your {Provider} to Dimension for ...`
- One subheading, e.g. `Email Intelligence`, `Smart Calendar Integration`, `Communication Intelligence`, `Project Intelligence`, `Smart File Operations`.
- One paragraph explaining agent value.
- Linear adds a second explanatory section: `Full Access`, describing read/write access and AI actions.

The overview is supporting content. It should never outrank account status or connection actions.

## Provider-Specific Detail Variants

### Google Drive Related Setup

Google Drive has an extra `Complete your Google Setup` section between trust and capabilities. See [`integration-google-drive-detail-2026-05-19.md`](./integration-google-drive-detail-2026-05-19.md).

Rows:

- Google Docs - `Create and edit Google Docs` - `Manage`
- Google Sheets - `Work with Google Sheets` - `Manage`
- Google Slides - `Create and edit Google Slides` - `Manage`

This belongs in metadata as `relatedProviders`, not hardcoded into the page.

### Google Workspace Connected Providers

Gmail and Google Calendar share the connected-account template and trust notice. Their differences are only provider copy, capabilities, and overview subheading. That confirms the provider-detail page can be one shared component.

### Slack / Unconnected Providers

Slack confirms the unconnected state:

- Primary CTA `Connect`.
- Account table placeholders `-`.
- Status `Not connected`.
- Provider-specific trust copy.
- Same capabilities and overview structure.

Earlier archived notes mention a marketing hero strip on Slack, but the live a11y tree in this pass did not expose it. Treat any provider hero as optional metadata; do not make the detail template depend on it.

### Linear / High-Risk Write Access

Linear adds a second overview block, `Full Access`, because connecting grants broad read/write permissions. Alfred should support optional extra disclosure sections for providers with destructive or broad write actions.

### Coming Soon

Coming-soon providers render in the catalog with the same row shell and a disabled/action label `Coming Soon`. Direct route access can fall through to 404. Alfred should either:

- disable the row and keep focus behavior clear, or
- open a non-routing `Coming soon` dialog/toast.

Do not route to an empty detail page for coming-soon providers unless there is meaningful setup content.

## Interaction And Accessibility Contract

- Catalog search is keyboard-focusable and filters results live.
- Empty/no-match state should preserve the page height gracefully.
- Section headings should stay semantic headings inside `<section>`.
- Provider rows must avoid nested buttons.
- Catalog rows need accessible names including provider name, description, and current action.
- Provider detail first route-local focus target is `All integrations`.
- `Connect` / `Add Account` opens a Radix `Dialog` or redirects into OAuth only after an explicit click.
- `Disconnect` opens Radix `AlertDialog`; no immediate destructive action.
- Account identity values are private; never hardcode them into demos or docs.
- Status is textual (`Active`, `Not connected`), not color-only.
- Capability labels should be read as list items or chips with normal text semantics.

## Alfred Build Checklist

1. Add provider metadata with ids, categories, descriptions, status, capabilities, trust notice, overview, and optional related providers.
2. Implement `/integrations` as a searchable, sectioned provider catalog.
3. Implement `/integrations/$provider` as one shared detail template.
4. Redirect or block unknown/coming-soon provider ids intentionally.
5. Add Radix `Dialog` for connect/add-account confirmation and Radix `AlertDialog` for disconnect.
6. Share provider metadata with composer mentions and connect-tools surfaces.
7. Add route-level tests for catalog filtering, provider detail rendering, and invalid provider behavior.
8. Verify keyboard order: sidebar, route back link, primary CTA, account actions, related providers, capabilities, overview.
