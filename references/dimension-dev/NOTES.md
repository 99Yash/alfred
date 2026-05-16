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

### `/chat/<threadId>` — same route, **with an artifact being generated**
Files: `13-chat-artifact-pages-populated.png`, `13b-chat-artifact-completed.png`, `snapshots/chat-artifact-pdf.txt`

Captured while the agent was processing the prompt *"… create a PDF and email it to me"* — a multi-tool run that does web research, then composes a 6-page PDF, then sends it via Gmail. As soon as the agent decides to produce an artifact, the right rail (the To Do / Suggestions / Briefing widgets) is swapped for an **artifact preview panel** co-located with the chat. So `/chat/<threadId>` has two right-rail modes — quick-access widgets by default, artifact viewer while an artifact is being authored.

**Artifact panel structure** (right side, full-height):
1. Header row: artifact title (`"Sycamore Labs — Key People & Role Preparation Guide"`), then four unlabeled icon buttons — share, download, open-in-fullscreen, close. Title is stamped by the LLM before any page resolves.
2. Body, empty state: `"No Pages Yet"` h-text + sub `"Pages appear here as they're generated"`, with a document-icon glyph.
3. Body, populated: a vertical stack of page rows. Each row is `[title strip "Cover Page" | "<n> / <total>" counter]` above an `<iframe>` that loads the page as HTML via `about:srcdoc`. While a page is mid-stream the iframe's RootWebArea carries `busy`; it clears when the page resolves.

**Streaming-status pattern in the chat stream**. The assistant message body interleaves three kinds of nodes:
- **Tool cards** — `[<tool name> ... results found]` expandable button + region of result rows (search hits with favicons; see `09b-chat-thread-action-expanded.png` for the same shape).
- **Thought-for pills** — `Thought for 4s`, `Thought for 13s`, `Thought for 20s` — collapsible CoT summary, one per "thinking" beat between tool calls.
- **Inline status text** — bare `StaticText` siblings of the cards, no container. These mutate in place as the tool runs. The two patterns I saw:
  - **Generic verb-ing → verb-ed**: `"Creating page..."` flips to `"Created Cover Page page."` once the LLM has named the page. Same DOM node, text replaced. So early in the stream you see one or more anonymous `"Creating page..."` rows that gradually get re-stamped with titles as the model decides what to name them.
  - **Icon + status**: `image "envelope"` + `"Email sent successfully."` — short rows that emoji-prefix a discrete tool finish. (Other icons seen: `user-search` for people lookups.)

**Per-tool action cards.** Tools that *do* something substantive (vs. just search) emit a labeled expandable button after their inline status: `Create PDF Document`, `Write E-Mail`. Different from the search cards in that they don't pre-expand — you have to click to see the call args. So the conversation pane carries three classes of tool surfacing:
1. **Search/lookup tools** — pre-expanded with the result list inline (`"sycamore.so company 10 results found"`).
2. **Action tools** — collapsed by default with the action name (`Create PDF Document`, `Write E-Mail`); side effects (the PDF, the sent email) are evidenced elsewhere (the panel for the PDF; nothing in-chat for the email beyond the status line).
3. **Bare inline status** — the streaming `"Creating <title> page..."` / `"PDF exported successfully."` / `"Email sent successfully."` rows.

**Run-level status**. The whole assistant turn is wrapped in a `Working on it...` h3 region that stays for the entire multi-step run — only one run-level indicator, per-step state lives in the inline stream. It clears when the final tool resolves.

**Pattern**: artifact = first-class right-rail entity, not a chat bubble. The user reviews the artifact in-place while the conversation pane stays available for follow-up prompts. Both panes are simultaneously alive — they're not modal — so the agent can keep talking while pages stream into the panel. This is the only place I saw the right rail get "borrowed" by a feature; the standard widgets snap back once the run ends (toggled by the `Open quick access` button in the top bar).

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

### `/` — marketing home (logged-out, incognito)
Files: `14-marketing-home.png`, `14b-home-tab-catch-up.png`, `14c-home-tab-action-plan.png`, `14d-home-tab-deep-work.png`, `14e-home-tab-inbox.png`, `14f-home-tab-meeting-prep.png`, `14g-home-tab-daily-recap.png`, `snapshots/marketing-home.txt`

**Hero**. Eyebrow `Introducing Dimension`, h1 `"The AI coworker that never sleeps."`, four value-prop bullets:

1. *Helps you get work done across 30+ apps*
2. *Drafts emails and preps meetings around the clock*
3. *Chat via iMessage, Slack, mobile, or web*
4. *Enterprise-grade encryption — we never train on your data*

Single primary CTA `Get Started`. No social proof, no logo wall, no testimonials — they trust the value props to do the work. The fourth bullet is a *security* promise placed at the same visual weight as the feature bullets, not buried in a separate trust section.

**The use-case showcase is the gold mine** (`14*-home-tab-*.png`). One section, h6 eyebrow `What Dimension handles for you`, then a left-column tab list of seven cases, each with its own illustrated panel on the right. The seven cases — *Morning Briefing, Catch Up, Action Plan, Deep Work, Inbox, Meeting Prep, Daily Recap* — are this product's complete story. Each panel pairs:

- A single sentence elevator pitch (e.g. *"Dimension auto-tags every inbound email so you know what needs action, what's FYI, and what's noise. Responses are pre-drafted in your tone so you can just hit send."*)
- A faithful mock of the actual in-app surface (not abstract illustration) — Action Plan's mock is the `Todo + SUGGESTIONS` widget from the right rail; Catch Up's is the same conversation-thread chrome as `/chat/<threadId>`; Daily Recap is a Resend-styled email from `hey@dimension.dev` opening "*That email from David this morning turned into a closed deal by end of day. $140K year one...*" — i.e. exactly the prose-up-front pattern the morning briefing uses.

**The seven cases are the same six "Features" agents from settings, plus one new one.** Compare the [`08b-settings-features.png`](screenshots/08b-settings-features.png) list to the home tabs:

| Settings (feature toggle) | Home (use-case tab) |
| --- | --- |
| Morning Briefing | Morning Briefing |
| Email Auto-Drafting | Catch Up |
| Action Items | Action Plan |
| — | Deep Work *(new — non-recurring, user-triggered)* |
| Email Tagging | Inbox |
| Meeting Prep | Meeting Prep |
| Evening Recap | Daily Recap |

So the marketing surface renames the always-on background agents into product-storyable buckets (`Action Items` → `Action Plan`, `Email Tagging` → `Inbox`, `Email Auto-Drafting` → `Catch Up`, `Evening Recap` → `Daily Recap`) and adds **Deep Work** as the explicit user-triggered "go-do-a-task" case. Deep Work is the only one not represented as a settings toggle because it isn't always-on — it's the on-demand agent run that fires when the user types a prompt.

**Lower sections**: a CTA band (`Your smartest coworker starts today.`), then a `FEATURES` strip with three more cards — *Search* (a results panel with sub-tabs across GitHub/Drive/Notion/Docs/Linear), *Everywhere* (the iMessage/Slack pitch with an "On the Go" illustration), *Integrations* (a logo grid mock). Then a final CTA `Double your time for deep work.`, then the footer.

**Footer choices worth noting**:
- `Login with SSO` is the only auth link, and it lives in the *footer*, not the top nav. Top right is reserved for `Get Started` (sign-up).
- No email/password option is exposed publicly.
- Their `Features` and `Use Cases` nav buttons are mega-menus (didn't expand them, but the `expandable` flag is on both).

**Patterns worth borrowing for Alfred's eventual landing page**:
- The seven-case grid is the right way to communicate a horizontal product like Alfred. The reader instantly sees the surface area without you having to write a "what Alfred does" prose section.
- One-sentence-per-case copy with a real product mock beats marketing prose every time.
- Putting `Enterprise-grade encryption — we never train on your data` at hero-bullet weight signals that the trust story is part of the value prop, not a compliance footnote.
- The marketing-name vs. settings-name divergence (`Email Auto-Drafting` ↔ `Catch Up`) is a small but real cost — pick one naming and stick with it. Alfred currently has `email-triage`, `morning-briefing`, `cold-start-research` as workflow slugs; the user-facing names should probably mirror dimension's *story-friendly* side, not the engineering slug.

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
11. **Artifact panel co-located with the chat** — long-form outputs (PDFs, slide decks, docs) render as live-streaming pages in the right rail of the same thread, not as attachments or links. The conversation stays usable while the artifact builds. Each page resolves independently, so the user sees structure (page titles, page count) before any content. This is the right place to lift from when we build Alfred's artifact surface — it's strictly better than a chat bubble with "here's your file."
12. **Streaming status text that mutates in place** — `"Creating page..."` → `"Created Cover Page page."` is a single text node whose contents flip when the step resolves. Much less visual noise than appending a fresh "done" line below the in-progress one, and it keeps the run timeline scannable.
13. **Three tiers of tool surfacing in the chat stream** — pre-expanded search cards, collapsed action-card buttons, and bare inline status text. Each tier matches how much the user needs to inspect the tool's output: search results are content (always shown), actions are evidenced elsewhere (collapsed by default), and bare status is just a heartbeat (not a card at all). We should resist the urge to wrap *every* tool call in a card.

## Patterns to leave behind / consider carefully

- **The plan/upgrade card in the bottom corner** of `/chat/new`. Necessary for them; we don't have a billing surface, so skip.
- **`Refer and earn credits` in primary nav.** Promo. Single-user, doesn't apply.
- **A flat thread list with no folders/projects.** Works at hobby scale, breaks past ~50 threads. Worth thinking about how to group long-term.
- **Locking the skill title after creation.** Feels like a Postgres-constraint leak, not a deliberate choice. Don't replicate.
- **No visible model picker except behind `Auto`**. Whether to expose models depends on Alfred's stance on model surfacing — current code routes per task type via `getBossModel/getCheapModel/etc.`, which is closer to `Auto` only. Probably keep ours opaque too.

## What's not in this archive but might matter later

- `/library/<artifactId>` — standalone artifact viewer route never visited; library was empty. We now have the **in-chat** artifact panel (`13-chat-artifact-pages-populated.png`), which is presumably the same iframe-per-page renderer as the library detail view, but with a different chrome wrapper. The library viewer probably adds: persistent header (no "Working on it"), version history, re-run / regenerate action.
- `/workflows/<id>` with `History` and `Approvals` tabs populated — only saw `Plan`.
- `/integrations/<provider>` for non-Google providers — schema may vary (Notion, Linear, etc.).
- The Share dialog from workflows/skills/chat.
- The **fullscreen** state of the artifact panel (the third icon button in its header). Likely just the iframe stack at viewport-width — worth checking before May 20 if we want it for reference.
- Artifact types other than PDF — the library type-filter menu lists Presentations, Documents, Spreadsheets, PDF Documents (`07b-library-types-menu.png`), so each presumably has its own page-renderer variant.
- Mobile / responsive views.
- The actual in-app Morning Briefing surface (only saw the marketing render).
- `/sandbox/*` routes from the recon doc — internal HIL experiments worth poking before May 20 if curious.
