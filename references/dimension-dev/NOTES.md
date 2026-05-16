# Dimension.dev UI study

Captured 2026-05-16 from a logged-in session at `https://dimension.dev` (deployment `dpl_HfumqwUvw2j9zVXSutQ6y2HiZDC4`, build `2Yg6GmRb0YtGO-YJVw6mf`).

The product is being shut down on 2026-05-20. This folder is a frozen reference of how they did it — pulled before the lights go out so we can lift specific patterns into Alfred deliberately.

For backend / architecture (Next.js Pages Router, tRPC, Ably, Replicache, etc.) see `../../dimension-dev-recon.md`. This file is only about the UI surface.

## Folder layout

- `screenshots/` — full-page PNGs of each captured route/state
- `snapshots/` — a11y trees (text) of the same states, useful for figuring out exact labels and component nesting
- `marketing-images/` — high-res product screenshots Dimension's own marketing pages embed (often cleaner reference than my logged-in shots because there's no shutdown banner, no real-data clutter)

## App chrome (shared across all authenticated routes)

Three-pane layout, **collapsible left sidebar + main + optional right rail**.

**Top, full-width**: shutdown notice banner — orange/yellow, dismissable. `"Dimension is winding down on May 20, 2026. We'll handle cancellations and refunds automatically. Learn more"`. We don't need this, but the banner pattern itself (full-width app-level notice that stays out of the way) is worth keeping in mind for service incidents.

**Left sidebar** (`00-chat-new-initial.png`):

1. User avatar at top + collapse toggle
2. Primary nav, vertically stacked with icon + label:
   - **New Chat** (with `⇧O` shortcut shown)
   - **Search** (with `⌘K` shortcut shown)
   - **Integrations**
   - **Workflows**
   - **Skills**
   - **Library**
   - **Refer and earn credits** (deep-links to `/settings?section=referrals`)
3. Recent threads — flat list, no folders, kebab menu per row (rename/delete/share). Shown as raw thread titles.
4. **Settings** pinned to the bottom.

The order is meaningful: the four product primitives — **Integrations, Workflows, Skills, Library** — are flat siblings under "create new chat" and "search." Everything else is built out of these four.

**Right rail** — only shown on `/chat/new` and `/chat/<thread>` (with an "Open quick access" toggle on thread pages to bring it back). Stacks four widgets vertically:

1. **Location + weather** strip (`Bhubaneswar 29°`) with three quick-actions (mic, email, video) — entry points for voice / email / video composition into a new chat.
2. **To Do** panel — three sub-tabs (something / envelope / something), then an `All` filter and an edit button. `Add new to do` inline composer. Looks like a unified inbox of action items pulled from integrations (see `/todo` marketing page below).
3. **SUGGESTIONS** — single proposed action with a sparkle icon. Mine: `"Submit FATCA/CRS forms to Nexus Select Trust REIT"`. So suggestions are proactive — pulled from email/calendar context, not user-typed.
4. **Morning Briefing** — button at the bottom that pops open the daily digest.

## Routes captured

### `/chat` and `/chat/new` — landing & new-chat composer
Files: `00-chat-new-initial.png`, `snapshots/chat-new.txt`

- Centered greeting: `Saturday, May 16th` (subtitle) above `Good Evening, Yash Gourav` (h1). Time-of-day-aware.
- Big multiline composer with placeholder `"Type and press enter to start chatting..."`. Below the composer, three chips:
  - Kebab menu (more options)
  - `Auto` mode toggle (pressed by default — implies they have manual model/mode override behind it)
  - Model picker combobox showing `Dimension`
  - Mic button
  - Send button (disabled until input has content)
- `Connect Your Tools` row below the composer — likely opens a quick integrations modal.
- Floating bottom-left card: `Upgrade your Plan — Get access to all features and more credits!` with `Upgrade Plan` CTA. This is the only non-chrome upsell on the page.

**Patterns worth borrowing**:
- The personalized greeting + composer-only landing is much better than a list of "starter prompts." Trusts the user to know what they want.
- The right rail surfaces *suggested* work (To Do, Suggestions, Morning Briefing) — the assistant pulls work to you instead of waiting to be asked. This is the product thesis.

### `/chat/<threadId>` — active conversation
Files: `09-chat-thread.png`, `09b-chat-thread-action-expanded.png`, `snapshots/chat-thread.txt`, `snapshots/chat-thread-action-expanded.txt`

Top bar: thread title (with kebab for rename/share/etc.), `Share` button, `Open quick access` button (re-opens the right rail).

Message stream styling:

- **User messages** — plain text, right-aligned-ish, no avatar shown
- **Assistant messages** with tool use are structured as:
  ```
  [collapsed pill]   "Finished one action" | "Gathered information"
                     ↓ when expanded:
                     [sub-pill] "Thought for 2s"
                     [body]     "Let me dig through your emails..."
                     [sub-pill] "<query text> — 8 results found"
                                ↓ when expanded:
                                bulleted list of email subjects (raw search results)
  [free text answer]  natural-language response with bolded entities
  [actions row]       clone (copy), thumbs-up, thumbs-up
  ```

So the disclosure model is **two-level nested progressive disclosure** — tool call → query → results. The "Thought for Xs" sub-pill is a separate disclosure for chain-of-thought summary. Each step is collapsed by default but inspectable on click.

The composer at the bottom of an active thread uses the same chip row as `/chat/new` plus a `Tab` autocomplete affordance shown in faded text.

**Pattern**: per-message reactions (thumbs up, copy) live on the *assistant* message only. Important — they don't pollute user-message rendering.

### `/workflows` — list of scheduled / triggered automations
Files: `01-workflows.png`, `snapshots/workflows.txt`

Simple page:
- H1 `Workflows` + sub `Create a scheduled or trigger-based workflow.`
- `Create Workflow` button (primary action)
- List of existing workflows as cards/rows: `<workflow title>` H3 + body `Click to edit your workflow`

That's it. Empty workflows have a placeholder title `Untitled workflow`. The actual workflow builder is at the detail route.

### `/workflows/<id>` — workflow builder
Files: `02-workflow-detail.png`, `02b-workflow-triggers-tab.png`, `snapshots/workflow-detail.txt`, `snapshots/workflow-triggers.txt`

Builder UI is split into header + body.

Header row: `All workflows` back-link, then a row with:
- Inline-editable title textbox (`Untitled workflow`)
- Kebab menu (delete/duplicate/etc.)
- `Share` button (upload icon, opens a dialog)
- `Auto approve` toggle
- `Activate` button (disabled until valid)

Top-level tabs: `Plan` / `History` / `Approvals`. `Approvals` is interesting — there's a queue for human-in-the-loop confirmation of risky workflow actions.

`Plan` tab body:
- **When** section — a sub-tabbed selector: `Schedule` | `Triggers`.
  - `Schedule` form: `From <starting date> run every <interval> <day|week|...> at <time>`. Natural-language form composition with inline combobox/buttons instead of a config form.
  - `Triggers` mode would let you set event-based firing — didn't expand it.
- **Prompt** section — large textarea with hint `"You can mention integrations using @ in the prompt"`.
- **Using Integrations** label hints at @ mentions surfacing connected tools.
- `Submit changes` button.

**Pattern**: workflows are just *prompts with a trigger*. The builder is not a node graph or DSL — it's the same chat composer with a schedule on top. Massively simpler to grok than tools that make you draw arrows.

### `/skills` — list of learned behaviors
Files: `03-skills.png`, `snapshots/skills.txt`

- H1 `Skills` + sub `Create a skill for your agent to learn.`
- `Create Skill` button
- Each existing skill is a card: title (h3) + the original prompt body as preview text.

Mine: `Jobs 2026 Apr — i want you to learn that i am still applying for jobs and ideally looking for something truly remote, with $40k/yr or beyond`.

### `/skills/<id>` — skill detail / memory view
Files: `04-skill-detail.png`, `snapshots/skill-detail.txt`

Header pattern: back-link `All skills`, locked title (`disabled` textbox holding the title — interesting, you can't rename after creation), `Last run at May 03 at 4:38 PM` next to a history icon, kebab menu, `Share` dialog button.

Tabs: `Learn` | `History`.

`Learn` body:
- The **Prompt** the user originally entered
- A **Memory Update** section — bulleted facts the agent extracted from the prompt + subsequent chat history. Examples from mine:
  - `Filter for fully remote roles only; reject any requiring in-office or hybrid`
  - `Set salary floor at $40,000/year for all opportunities`
  - `Target Fullstack Engineer, Founding Engineer, Product Engineer, AI Engineer roles`
  - `GitHub 99Yash with 20+ deployed Next.js projects as portfolio proof`
  - … 11 bullets total, mix of preferences + biographical facts
- Expand-to-modal button, an unlabeled secondary button, and an `Approve` button.

So **skills = a *long-lived* prompt that produces an editable memory record**, and the user can approve/reject memory updates. This is exactly the "user_facts" + "memory_chunks" model Alfred already has (see ADR-0019 + the cold-start research milestone in `CLAUDE.md`). Dimension's UI for it is: one tab for the source prompt, one tab for run history, and an explicit human approval step on memory writes. That's a much cleaner surfacing than what we have today.

### `/integrations` — catalog
Files: `05-integrations.png`, `snapshots/integrations.txt`

Search box at the top, then **categorized lists** with each connector as a wide row containing icon + name + short description + right-side action button (`Manage` if connected, `Connect` if available, `Coming Soon` if not yet).

Categories (in order shown):
1. **Connected** — promotes the user's actually-connected providers to the top.
2. **Apps** — iMessage, Slack Bot (text-Alfred-on surfaces)
3. **Productivity** — Google Sheets/Slides/Docs, Slack, Granola, Linear, Dropbox, Asana, Figma (coming soon)
4. **Business** — HubSpot, Airtable, Ramp, Mercury, Stripe, Intercom (coming soon)
5. **Development** — Sentry, PostHog, Supabase, Better Stack / Cloudflare / Databricks / Netlify (all coming soon)
6. **Your Integrations** — single row: `MCP Server — Connect any MCP server — [Add Integration]`. MCP gets its own category because it's the user-extensible escape hatch.

### `/integrations/<provider>` — connector detail
Files: `06-integration-gmail-detail.png`, `snapshots/integration-gmail.txt`

Route uses snake_cased provider keys: `/integrations/google_gmail`, not `/integrations/gmail`. Provider keys are namespaced (`google_gmail`, `google_calendar`, `google_drive`).

Body:
- Header with `All integrations` back-link, big icon + name + description, `Add Account` button (multi-account support)
- **Connected accounts table** — columns `Date | Status | <email>`. Each row has `Disconnect` action.
- **"Your data is indexed & encrypted"** trust banner — explicit promise that they don't train on user data or share with third parties. Earns trust at the moment of connection.
- **Capabilities** list — flat bullets: `Read Emails`, `Compose Emails`, `Send Emails`, `Reply to Emails`, `Manage Labels`, `Search Conversations`, `Handle Attachments`. These are the granular scopes presented in plain English, not OAuth scope names.
- **Overview** text + **Email Intelligence** marketing copy explaining what the agent does with this integration.

**Pattern**: a connector detail page = trust + capabilities + accounts table. No raw OAuth scope strings, no JSON. The capability bullets are the same primitives the agent's tool-call descriptions use.

### `/library` — artifact archive
Files: `07-library-empty.png`, `07b-library-types-menu.png`, `snapshots/library.txt`, `snapshots/library-types-menu.txt`

- H1 `Library` + sub `Browse all your created artifacts.`
- Type filter button (`All Types`) opens a checkbox menu with: **All Types, Presentations, Documents, Spreadsheets, PDF Documents**
- `Favourites` tab
- Search bar
- Empty state: `"Nothing in the library"`

So `library` is a unified gallery of *agent-generated outputs* — slides, docs, sheets, PDFs are all first-class artifacts. They map to the tRPC `artifacts.*` namespace seen in the recon doc.

### `/settings` — multi-section settings page
Files: `08-settings-user.png`, `08b-settings-features.png`, `08c-settings-preferences.png`, plus snapshots

Left sub-nav (within settings main):
- **User** — username, email, **Preferred Mode of Communication** tabs (`Gmail | Slack | iMessage | Mobile Notifications`, only Gmail enabled for me), **Auto Approve** toggle (`When enabled, critical actions will execute without asking for your approval.`), **Background** ("Tell us about yourself" free-form text), Logout, Delete Account
- **Billing**
- **Plan**
- **Features** (sliders icon) — see below
- **Preferences** (settings icon) — Promotional Emails, Product Updates, Sound (`Always play sound | Only when tab is not focused | Mute` radio for run-complete notification), Cookies
- **Referrals**

**Features tab is the gold mine** (`08b-settings-features.png`). It exposes their full first-party agent catalog as individually-toggleable **Background Agents**:

| Agent | Description (verbatim) |
| --- | --- |
| Action Items | Pulls action items from your apps and flags what's urgent |
| Evening Recap | A daily summary of what got done and what's still open |
| Morning Briefing | Your schedule, tasks, and key updates — delivered each morning |
| Email Tagging | Tags every inbound email so you know what needs action |
| Email Auto-Drafting | Drafts replies in your tone so you can review and send |
| Meeting Prep | Briefs you on attendees, talking points, and past context |

This is the **default workflow catalog** the product ships with. Each one is what we'd call a "builtin workflow" — the same shape as `email-triage`, `morning-briefing`, `cold-start-research` in Alfred today (`apps/server/src/builtins/workflows/*`). Three of these six already correspond to milestones we've shipped or planned (Morning Briefing m10, Email Tagging ≈ m9 triage, Cold Start ≈ none of these directly — closer to "Background" prose).

**Pattern**: every built-in agent shows up as a switch in settings. Users can turn them off. No invisible always-on automation. Worth replicating.

### Search palette (`⌘K`)
Files: `11-search-palette.png`, `snapshots/search-palette.txt`

Modal centered overlay. Title `Search for chats or navigate`. Single combobox input. Default suggestions (with no query typed) are the nav destinations: `New Chat, Settings, Integrations, Workflows, Skills, Library`. Shortcut bar at bottom: `⇧↩ / ↩ / ↑↓ / esc`.

So this is a Linear-style command palette doing double duty as both **navigation** and **chat search**.

### `/morning-briefing` (marketing) and `/todo` (marketing)
Files: `10-morning-briefing-marketing.png`, `12-todo-marketing.png`, plus `marketing-images/*`

These public URLs are marketing landing pages, not the in-app surface. They're useful because they embed clean product screenshots of the actual in-app UI for those features. See `marketing-images/morning-briefing-borderless.png` and `marketing-images/todo-list.png` for the in-app reference.

The morning briefing from those shots: city/temp top, big greeting `Enjoy your Day, <name>.`, headline like `"You have 3 Meetings and 23 Emails."`, then a paragraph in prose (`"It's a quiet day on the calendar..."`), then two columns `TO DO` and `SUGGESTIONS`. So the briefing is a *prose summary up front, not a bullet list* — the bullets sit below as the actionable bits.

## Cross-cutting product concepts

The four primitives that organize the whole product:

1. **Integrations** — what the agent can touch
2. **Skills** — long-lived memories/preferences the agent applies on every run
3. **Workflows** — prompts with a trigger (schedule or event)
4. **Library** — agent-generated artifacts (slides/docs/sheets/PDFs), unified

Plus three "always-on surfaces":

5. **To Do** — action items pulled from apps, optionally delegated back
6. **Suggestions** — single proactive recommendation
7. **Morning Briefing / Evening Recap** — periodic digests

Alfred today maps cleanly: integrations ✓, memory primitives ✓ (≈ skills), agent runs / workflows ✓, artifacts not yet. To Do, Suggestions, and the digest surfaces are exactly the user-facing manifestations of the agent runs we already run server-side — we just don't show them anywhere yet.

## Patterns worth borrowing

1. **Four-pillar nav** — Integrations / Workflows / Skills / Library as flat siblings instead of nested. They make the conceptual surface visible and small.
2. **Workflows = prompt + trigger** — no node graph, no DSL. The schedule UI is a natural-language form (`From X run every Y day at Z`).
3. **@-mention integrations in prompts** — referenced as "you can mention integrations using @ in the prompt." Lets the user be explicit about which tool to use, inline.
4. **Background agents catalog in Settings** — every always-on automation is a toggle in `Settings → Features`, never invisible.
5. **Skill = prompt + extracted memory + explicit approval** — separates the source of truth (the prompt) from what's actually persisted (the bullets), with a human-in-the-loop step.
6. **Two-level disclosure for tool use in chat** — collapsed pill → expand → see query + result list. "Thought for Xs" as a sibling pill, not a layer above.
7. **Connector page = trust banner + capabilities-in-English + accounts table** — none of OAuth's UX bled through.
8. **Right rail as proactive surface** — To Do, Suggestions, Morning Briefing pull work *to* the user instead of waiting for prompts.
9. **`Auto approve` everywhere it's risky** — global setting in user profile, per-workflow override. Recognises that approval friction is the main UX tax.
10. **Command palette doubles as navigation** — `⌘K` opens chat search; default state is nav links.

## Patterns to leave behind / consider carefully

- **The plan/upgrade card in the bottom corner** of `/chat/new`. Necessary for them; we don't have a billing surface, so skip.
- **`Refer and earn credits` in primary nav.** Promo. Single-user, doesn't apply.
- **A flat thread list with no folders/projects.** Works at hobby scale, breaks past ~50 threads. Worth thinking about how to group long-term.
- **Locking the skill title after creation.** Feels like a Postgres-constraint leak, not a deliberate choice. Don't replicate.
- **No visible model picker except behind `Auto`**. Whether to expose models depends on Alfred's stance on model surfacing — current code routes per task type via `getBossModel/getCheapModel/etc.`, which is closer to `Auto` only. Probably keep ours opaque too.

## What's not in this archive but might matter later

- `/library/<artifactId>` — never visited; library was empty. Would show the artifact viewer (slide deck / doc / sheet).
- `/workflows/<id>` with `History` and `Approvals` tabs populated — only saw `Plan`.
- `/integrations/<provider>` for non-Google providers — schema may vary (Notion, Linear, etc.).
- The Share dialog from workflows/skills/chat.
- Mobile / responsive views.
- The actual in-app Morning Briefing surface (only saw the marketing render).
- `/sandbox/*` routes from the recon doc — internal HIL experiments worth poking before May 20 if curious.
