# Dimension route DOM blueprints for Alfred — 2026-05-19

Purpose: make the archived Dimension UI rebuildable with Alfred's local primitives and Radix-style headless components. This complements the visual/token references; it is a route-by-route DOM/component blueprint.

Primary evidence:

- [`NOTES.md`](./NOTES.md) — route inventory and behavior notes
- [`dimension-design-reference-2026-05-18.md`](./dimension-design-reference-2026-05-18.md) — tokens, primitive recipes, route-level geometry
- [`final-live-ui-recon-2026-05-18.md`](./final-live-ui-recon-2026-05-18.md) — final broad preservation pass
- [`live-ui-reference-2026-05-19.md`](./live-ui-reference-2026-05-19.md) — fresh live `/chat` capture + source-map status
- [`chat-meeting-prep-reference-2026-05-19.md`](./chat-meeting-prep-reference-2026-05-19.md) — late meeting-prep card/dialog capture + accessibility contract
- [`weather-and-route-notes-2026-05-19.md`](./weather-and-route-notes-2026-05-19.md) — final weather/right-rail specifics and secondary-route traversal notes
- [`chat-tool-rendering-sycamore-2026-05-19.md`](./chat-tool-rendering-sycamore-2026-05-19.md) — completed research-run tool trace, nested accordion contract, citation/reaction/composer details, and artifact iframe absence in the current Sycamore route
- [`screenshots/`](./screenshots/) and [`snapshots/`](./snapshots/) — per-state viewport and a11y evidence

## Reconstruction rule

Recreate Dimension as Radix-equivalent DOM and behavior, not byte-for-byte DOM. Source maps are not exposed. Exact internal component names and wrapper counts are not recoverable. The recoverable contract is:

- ARIA roles and labels from snapshots.
- Keyboard/focus behavior implied by Radix-like primitives.
- Layout, copy, dimensions, visual recipes, and data-state styling from computed styles and screenshots.
- Minified bundle strings only for confirming class recipes and asset names.

Use Radix `asChild` wherever possible: our `Button`, `IconButton`, `Input`, `Textarea`, `Card`, and `FrostPanel` own visuals; Radix owns ARIA, focus, keyboard interaction, popper positioning, portals, and `data-state`.

## Primitive dependency map

| Dimension surface | Preferred Alfred primitive | Radix package/status |
| --- | --- | --- |
| Search modal / command palette | `CommandPalette` | `@radix-ui/react-dialog` + `cmdk` installed |
| Modal dialogs | `Dialog`, `DialogContent` | `@radix-ui/react-dialog` installed |
| Rail tabs / detail tabs | `Tabs` visual recipe | local hand-rolled; can migrate to `@radix-ui/react-tabs` |
| Todo checkbox | `Checkbox` wrapper | add `@radix-ui/react-checkbox` |
| Model picker | `ModelPicker` using Popover | add `@radix-ui/react-popover` |
| Composer `+` menu | `ContextMenuButton` using Popover or Dropdown Menu | add `@radix-ui/react-popover` or `@radix-ui/react-dropdown-menu` |
| Row kebab menus | `DropdownMenu` wrapper | add `@radix-ui/react-dropdown-menu` |
| Icon tooltips | `Tooltip` wrapper | add `@radix-ui/react-tooltip` |
| Rich chat composer / mentions | TipTap/ProseMirror + Popover | separate editor migration, not solved by Radix |
| Toast region | Sonner-like toaster | optional later |

## Shared authenticated app shell

Evidence: `screenshots/32-final-pass-chat-new-2026-05-18.png`, `screenshots/46-live-chat-home-2026-05-19.png`, `snapshots/final-pass-chat-new-2026-05-18.txt`, `snapshots/live-chat-home-2026-05-19.txt`.

DOM target:

```tsx
<div className="app-root dark">
  <SystemBanner />
  <main className="flex min-h-0 flex-1 overflow-hidden">
    <aside className="sidebar">
      <ProfileButton />
      <nav aria-label="Primary">
        <NavItem href="/chat" icon="plus-message">New Chat <Kbd>⇧ O</Kbd></NavItem>
        <button onClick={openCommandPalette}>Search <Kbd>K</Kbd></button>
        <NavItem href="/integrations">Integrations</NavItem>
        <NavItem href="/workflows">Workflows</NavItem>
        <NavItem href="/skills">Skills</NavItem>
        <NavItem href="/library">Library</NavItem>
        <ReferralBanner />
      </nav>
      <RecentThreads />
      <footer>
        <NavItem href="/settings">Settings</NavItem>
      </footer>
    </aside>

    <section className="main-route-slot" />
    <aside className="right-rail-slot" />
  </main>
  <CommandPalette />
</div>
```

Build notes:

- Sidebar rows are `h-10`, `rounded-xl`, icon + label + optional kbd chip.
- Search is a button, not a route. It opens the command palette.
- Product pillars are flat siblings: Integrations, Workflows, Skills, Library.
- Recent-thread rows need a trailing kebab. Use Radix Dropdown Menu when that behavior exists.
- Settings stays pinned in the footer.

## `/chat` landing

Evidence: `screenshots/32-final-pass-chat-new-2026-05-18.png`, `screenshots/46-live-chat-home-2026-05-19.png`, `home-fidelity-gaps-2026-05-18.md`, `live-ui-reference-2026-05-19.md`, `chat-meeting-prep-reference-2026-05-19.md`.

DOM target:

```tsx
<ChatLanding>
  <section className="center-column">
    <p className="home-date">Tuesday, May 19th</p>
    <h1 className="heading-display">Good Morning, Yash</h1>

    <ComposerShell>
      <ComposerEditor placeholder="Type and press enter to start chatting..." />
      <ComposerToolbar>
        <ComposerAddPopover />
        <AutoToggle />
        <CreditsNotice />
        <ModelPickerPopover />
        <IconButton aria-label="Dictate" />
        <Button variant="send" aria-label="Send" />
      </ComposerToolbar>
    </ComposerShell>

    <ConnectToolsRow />
    <UpcomingMeetingCard />
    <SetupOrUpgradeBanner />
  </section>

  <QuickAccessRail defaultTab="todo" />
</ChatLanding>
```

Component breakdown:

| Component | DOM/primitive | Key details |
| --- | --- | --- |
| `ComposerShell` | plain div | `max-w-[656px]`, `rounded-2xl`, dark translucent fill, editor min-height `50px`, max-height `320px`, editor mask fade top/bottom 12px |
| `ComposerAddPopover` | Radix Popover trigger as `IconButton` | content rows: `Add photos & files`, `Mention`; `frost-popover rounded-2xl p-2` |
| `AutoToggle` | button with `aria-pressed` | `71×31`, `rounded-[10px]`, gradient `#0f0f0f -> #1e1e1e`, 4px blur |
| `ModelPickerPopover` | Radix Popover trigger | trigger `107×29`, `rounded-lg`, gradient `#0c0c0c -> #151515`, inset shadow; rows for `Dimension` / `Dimension Pro` analogs |
| `ConnectToolsRow` | button/link | attached to composer, `656×46`, `rounded-b-2xl`, provider glyphs + label |
| `UpcomingMeetingCard` | plain/frost card | label `UPCOMING MEETING`, title, time, join action |
| `SetupOrUpgradeBanner` | absolute bottom overlay | ~`655×72`, `rounded-3xl`, video/animated background, `Button variant="white"` CTA |

Alfred route target: `apps/web/src/routes/index.tsx`, then extract `ComposerShell`, `ModelPicker`, `QuickAccessRail` once stable.

### `/chat` upcoming meeting prep

Late 2026-05-19 live behavior added generated meeting preparation to the center landing column. Full implementation details live in [`chat-meeting-prep-reference-2026-05-19.md`](./chat-meeting-prep-reference-2026-05-19.md), with a standalone repro at [`html-repros/chat-meeting-prep-2026-05-19.html`](./html-repros/chat-meeting-prep-2026-05-19.html).

DOM target:

```tsx
<UpcomingMeetingCard>
  <p className="meeting-label">UPCOMING MEETING</p>
  <div className="meeting-row">
    <VideoIcon aria-hidden />
    <div>
      <p>
        <span>{meeting.title}</span>
        <span aria-hidden>  •  </span>
        <time>{start}</time>
        <span aria-hidden> - </span>
        <time>{end}</time>
      </p>
      <p>{meetingPrep.summary}</p>
    </div>

    <Dialog>
      <DialogTrigger asChild>
        <IconButton aria-label="View meeting prep" />
      </DialogTrigger>
      <MeetingPrepDialog />
    </Dialog>

    <Button asChild variant="ghost">
      <a href={joinUrl}>Join</a>
    </Button>
  </div>
</UpcomingMeetingCard>
```

Dialog target:

```tsx
<DialogContent
  title="Meeting Prep"
  description="Meeting preparation notes."
  className="w-[min(768px,calc(100vw-2rem))] max-h-[calc(100vh-5rem)] rounded-3xl frost-border bg-[#1b1b1b] backdrop-blur"
>
  <DialogTitle>Meeting Prep</DialogTitle>
  <DialogDescription className="sr-only">Meeting preparation notes.</DialogDescription>
  <DialogClose asChild><IconButton aria-label="Close Dialog" /></DialogClose>
  <ScrollArea>
    <section aria-labelledby="where-things-stand">
      <h3 id="where-things-stand">Where things stand:</h3>
      <p>{summary}</p>
    </section>
    <section aria-labelledby="open-items">
      <h3 id="open-items">Open items to track status on:</h3>
      <ul>{items.map(item => <li />)}</ul>
    </section>
    <section aria-labelledby="attendees">
      <h3 id="attendees">Who's usually in the room:</h3>
      <p>{attendeeSummary}</p>
    </section>
  </ScrollArea>
</DialogContent>
```

Accessibility requirements:

- Trigger announces `View meeting prep`, `button`, `has popup dialog`.
- Dialog has title + description and should include `aria-modal="true"`.
- Initial focus should land on heading/content or `Close Dialog`, not an unlabeled footer action.
- Every icon-only action must have `aria-label`.
- `Tab` and `Shift+Tab` wrap inside the dialog.
- `Escape` closes and restores focus to `View meeting prep`.
- Background scroll is locked while open.

## Quick access rail

Evidence: chat landing screenshots, `screenshots/34-quick-rail-emails-tab-2026-05-18.png`, `screenshots/35-quick-rail-meetings-tab-2026-05-18.png`.

Companion detail: [`weather-and-route-notes-2026-05-19.md`](./weather-and-route-notes-2026-05-19.md) captures the final live weather video geometry, route calls, tab/accessibility notes, and exact style anchors for this rail.

DOM target:

```tsx
<aside className="quick-rail">
  <WeatherVideo />
  <header>
    <p>Bhubaneswar 30°</p>
    <h2>To Do</h2>
  </header>

  <Tabs.Root value={tab} onValueChange={setTab}>
    <Tabs.List className="rail-mode-tabs">
      <Tabs.Trigger value="todo"><BoxCheckIcon /></Tabs.Trigger>
      <Tabs.Trigger value="emails"><EnvelopeIcon /></Tabs.Trigger>
      <Tabs.Trigger value="meetings"><VideoIcon /></Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="todo">
      <TodoFilterRow />
      <AddTodoRow />
      <SuggestionsSection />
      <MorningBriefingButton />
    </Tabs.Content>

    <Tabs.Content value="emails">
      <RailEmptyState title="All done!" subtitle="No pending email drafts." />
    </Tabs.Content>

    <Tabs.Content value="meetings">
      <RailEmptyState title="All done!" subtitle="You have no meetings scheduled for today." />
    </Tabs.Content>
  </Tabs.Root>
</aside>
```

Build notes:

- Rail is `rounded-3xl`, media-backed, with video playback rate `0.5`.
- Weather header has no map-pin icon and no `Local weather` label.
- Segmented tab track is `bg-black/20`, `rounded-2xl`, cells `56×36`, `rounded-[14px]`.
- Add-todo row uses Radix Checkbox plus transparent `Textarea variant="inline"`.
- `SUGGESTIONS` is left-aligned and uses `mix-blend-plus-lighter` over media.
- Icon-only rail tabs need explicit `aria-label`s in Alfred; the live Dimension tree did not expose useful names for every tab.

## `/chat/<threadId>` active conversation

Evidence: `screenshots/09-chat-thread.png`, `screenshots/09b-chat-thread-action-expanded.png`, `screenshots/20-chat-completed-expanded.png`, `screenshots/20b-chat-all-expanded.png`, `screenshots/21-chat-code-tables-headings.png`, `chat-anatomy.md`.

DOM target:

```tsx
<ChatThread>
  <ThreadTopBar>
    <ThreadTitle />
    <DropdownMenuTrigger />
    <Button variant="ghost">Share</Button>
    <Button variant="ghost">Open quick access</Button>
  </ThreadTopBar>

  <ChatScrollArea>
    <UserMessageBubble />
    <AssistantTurn>
      <RunSummaryDisclosure />
      <ToolTimeline />
      <AssistantProse />
      <AssistantActions />
      <RelatedSuggestions />
    </AssistantTurn>
  </ChatScrollArea>

  <ThreadComposer />
</ChatThread>
```

Radix/component choices:

- Use Radix Dropdown Menu for thread title/kebab actions.
- Use a local `Disclosure` or Radix Collapsible/Accordion for run summaries and tool details.
- User message is a right-aligned bubble; assistant prose is not a bubble.
- Tool timeline has three node classes: search result disclosure, action-tool disclosure, inline status row.
- Active-thread composer supports Dimension's `Tab` accepted suggestion overlay.

### Completed research-run tool trace

Evidence: [`chat-tool-rendering-sycamore-2026-05-19.md`](./chat-tool-rendering-sycamore-2026-05-19.md) and [`html-repros/chat-tool-rendering-2026-05-19.html`](./html-repros/chat-tool-rendering-2026-05-19.html).

DOM target:

```tsx
<AssistantTurn>
  <Accordion.Root type="multiple" defaultValue={["run-1"]}>
    <Accordion.Item value="run-1">
      <Accordion.Trigger>Searched multiple sources</Accordion.Trigger>
      <Accordion.Content>
        <ThoughtDisclosure duration="2s" />
        <SearchResultsDisclosure query="Company research" resultCount={10} />
        <SearchResultsDisclosure query="Technical direction" resultCount={10} />
        <InlineToolStatus>Processed profile URL.</InlineToolStatus>
        <ThoughtDisclosure duration="2s" />
        <SearchResultsDisclosure query="Hiring and roles" resultCount={10} />
        <InlineToolStatus icon="user-search">
          People search completed successfully.
        </InlineToolStatus>
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>

  <ThoughtDisclosure duration="34s" />
  <MarkdownResponse />
  <ResponseActions />
</AssistantTurn>
```

Build notes:

- Top-level run summary trigger is full conversation width (`max-w-5xl` / 1024px); nested tool rows are inset about 37px.
- Search-result groups are open by default inside an expanded run summary, capped at `max-height: 130px`, and rendered as real links with Google favicon service images.
- Thought disclosures are muted (`rgb(112,112,112)`) and use the same accordion mechanics, but no card chrome.
- Status rows stay as plain inline rows; do not wrap them in cards.
- The current Sycamore route has zero iframes and no artifact/PDF panel. Mount the artifact iframe panel only when an artifact card exists.
- Reaction buttons should keep Dimension's three-icon visual order, but Alfred should provide explicit `aria-label`s instead of relying on repeated SVG titles.

## Chat artifact viewer mode

Evidence: `screenshots/13-chat-artifact-pages-populated.png`, `screenshots/13-chat-pdf-generation.png`, `screenshots/13b-chat-artifact-completed.png`, `artifact-html/README.md`.

DOM target:

```tsx
<ChatThread>
  <ChatPane />
  <ArtifactPanel>
    <ArtifactHeader>
      <h2>{artifactTitle}</h2>
      <IconButton aria-label="Share" />
      <IconButton aria-label="Download" />
      <IconButton aria-label="Open fullscreen" />
      <IconButton aria-label="Close" />
    </ArtifactHeader>

    <ArtifactPageList>
      <ArtifactPage title="Cover Page" index={1} total={6}>
        <iframe srcDoc={pageHtml} title="Cover Page" />
      </ArtifactPage>
    </ArtifactPageList>
  </ArtifactPanel>
</ChatThread>
```

Build notes:

- Artifact panel borrows the right rail; it is not a modal.
- Each page row has a title strip and count (`1 / 6`) above an iframe.
- Page busy/loading state belongs on the page row/iframe region, not the whole panel.
- Header buttons are icon-only with tooltips.

## `/integrations` catalog

Evidence: `screenshots/05-integrations.png`, `screenshots/36-final-pass-integrations-connected-2026-05-18.png`, `snapshots/integrations.txt`, `snapshots/final-pass-integrations-connected-2026-05-18.txt`, plus the consolidated live capture in [`integrations-overall-design-2026-05-19.md`](./integrations-overall-design-2026-05-19.md).

DOM target:

```tsx
<RoutePage>
  <PageHeader align="center" title="Integrations" subtitle="Connect Alfred to your tools." />
  <Input variant="search" />

  <IntegrationSection title="Connected">
    <IntegrationRow status="connected" action="Manage" />
  </IntegrationSection>

  <IntegrationSection title="Apps" />
  <IntegrationSection title="Productivity" />
  <IntegrationSection title="Business" />
  <IntegrationSection title="Development" />
  <IntegrationSection title="Your Integrations" />
</RoutePage>
```

Build notes:

- Search input is full width, max ~640px, rounded-full.
- Sections collapse when search returns no rows.
- Rows are `Card interactive`: icon tile, name, description, trailing `Button variant="ghost"`.
- Connected providers are promoted to top.
- MCP Server lives in `Your Integrations`.

## `/integrations/<provider>` connector detail

Evidence: `screenshots/06-integration-gmail-detail.png`, `screenshots/18-integration-slack.png`, `snapshots/integration-gmail.txt`, plus the authenticated Google Drive detail capture in [`integration-google-drive-detail-2026-05-19.md`](./integration-google-drive-detail-2026-05-19.md) and the cross-provider design in [`integrations-overall-design-2026-05-19.md`](./integrations-overall-design-2026-05-19.md).

DOM target:

```tsx
<ConnectorDetail>
  <BackLink>All integrations</BackLink>
  <Header>
    <ProviderIcon />
    <div>
      <h1>Gmail</h1>
      <p>Read, search, and draft email.</p>
    </div>
    <Button>Add Account</Button>
  </Header>

  <ConnectedAccountsTable />
  <TrustBanner title="Your data is indexed & encrypted" />
  <RelatedProviderSetup /> {/* Google Drive -> Docs, Sheets, Slides */}
  <CapabilitiesList />
  <OverviewSection />
</ConnectorDetail>
```

Radix/component choices:

- Add Account can open Radix Dialog if account/scopes need confirmation.
- Disconnect action should use Radix Alert/Dialog later.
- Accounts table is a plain table or `FrostPanel` depending density.
- Capability bullets are user-facing scope names, not raw OAuth scopes.
- Google Drive detail has a provider-specific `Complete your Google Setup` section for Google Docs, Google Sheets, and Google Slides. Do not model this as a generic upsell card; it is a quiet row list in the route content column.
- Avoid Dimension's nested-button accessibility issue in the related-provider rows: make the whole row a single link/button or put exactly one trailing action inside a non-interactive row.

## `/workflows` list

Evidence: `screenshots/01-workflows.png`, `snapshots/workflows.txt`, `screenshots/17-workflow-history-tab.png`, `screenshots/17b-workflow-approvals-tab.png`, plus the final live traversal in [`weather-and-route-notes-2026-05-19.md`](./weather-and-route-notes-2026-05-19.md).

DOM target:

```tsx
<RoutePage>
  <PageHeader align="center" title="Workflows" subtitle="Create a scheduled or trigger-based workflow." />
  <Button>Create Workflow</Button>
  <WorkflowGrid>
    <Card interactive>
      <h3>Morning Briefing</h3>
      <p>{workflowPreview}</p>
      <StatusPill />
    </Card>
  </WorkflowGrid>
</RoutePage>
```

Build notes:

- Current live list uses a frosted card grid, not the earlier simple row list.
- Workflow cards are about `334×244`, `p-6`, `rounded-3xl`, with a `#181818 -> #131313` gradient, frost border, title, preview copy, and status/action pill.
- Create Workflow is the primary purple CTA.
- Empty and user-authored states should keep the same card-grid grammar.

## `/workflows/<id>` builder

Evidence: `screenshots/02-workflow-detail.png`, `screenshots/02b-workflow-triggers-tab.png`, `screenshots/16-workflow-share-dialog.png`, `screenshots/17-workflow-history-tab.png`, `screenshots/17b-workflow-approvals-tab.png`.

DOM target:

```tsx
<WorkflowDetail>
  <BackLink>All workflows</BackLink>
  <Header>
    <EditableTitle />
    <DropdownMenuTrigger />
    <DialogTrigger asChild><Button variant="ghost">Share</Button></DialogTrigger>
    <SwitchLikeAutoApprove />
    <Button>Activate</Button>
  </Header>

  <Tabs.Root value={tab}>
    <Tabs.List>
      <Tabs.Trigger value="plan">Plan</Tabs.Trigger>
      <Tabs.Trigger value="history">History</Tabs.Trigger>
      <Tabs.Trigger value="approvals">Approvals</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="plan">
      <WhenSection>
        <Tabs.Root value="schedule">
          <Tabs.Trigger value="schedule">Schedule</Tabs.Trigger>
          <Tabs.Trigger value="triggers">Triggers</Tabs.Trigger>
        </Tabs.Root>
        <NaturalLanguageScheduleForm />
      </WhenSection>
      <PromptTextarea />
      <UsingIntegrationsHint />
      <Button>Submit changes</Button>
    </Tabs.Content>
  </Tabs.Root>
</WorkflowDetail>
```

Radix/component choices:

- Use Radix Tabs if migrating for parity; current local underline tabs can match visually.
- Share dialog uses existing Radix Dialog wrapper.
- Kebab uses Dropdown Menu.
- Auto approve can stay local Switch or migrate to Radix Switch when installed.
- The builder is prompt + trigger. Do not create a DAG editor.

## `/skills` list

Evidence: `screenshots/03-skills.png`, `snapshots/skills.txt`, plus the final live traversal in [`weather-and-route-notes-2026-05-19.md`](./weather-and-route-notes-2026-05-19.md).

DOM target:

```tsx
<RoutePage>
  <PageHeader align="center" title="Skills" subtitle="Create a skill for your agent to learn." />
  <Button>Create Skill</Button>
  <SkillGrid>
    <Card interactive>
      <h3>{skillTitle}</h3>
      <p>{originalPromptPreview}</p>
    </Card>
  </SkillGrid>
</RoutePage>
```

Build notes:

- Current live skill list uses a frosted card grid matching workflows.
- Skill cards are about `334×209`, `p-6`, `rounded-3xl`, text-first, with no heavy iconography required.
- Clamp long prompt previews so card height stays stable.
- Create Skill starts a draft and navigates directly into detail in Alfred.

## `/skills/<id>` detail

Evidence: `screenshots/04-skill-detail.png`, `snapshots/skill-detail.txt`, `screenshots/45-auto-off-skill-review-no-gate-2026-05-18.png`.

DOM target:

```tsx
<SkillDetail>
  <BackLink>All skills</BackLink>
  <Header>
    <ReadonlyOrEditableTitle />
    <LastRunMeta />
    <DropdownMenuTrigger />
    <DialogTrigger asChild><Button variant="ghost">Share</Button></DialogTrigger>
  </Header>

  <Tabs.Root value={tab}>
    <Tabs.List>
      <Tabs.Trigger value="learn">Learn</Tabs.Trigger>
      <Tabs.Trigger value="history">History</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="learn">
      <PromptSection />
      <MemoryUpdateSection>
        <MemoryBulletList />
        <Button variant="ghost">Expand</Button>
        <Button variant="primary">Approve</Button>
      </MemoryUpdateSection>
    </Tabs.Content>

    <Tabs.Content value="history">
      <RunHistoryList />
    </Tabs.Content>
  </Tabs.Root>
</SkillDetail>
```

Build notes:

- Skill detail is the cleanest place to converge Alfred skills and memory approvals.
- Memory update bullets should render as inspectable/editable rows before approval.
- Share uses Dialog; kebab uses Dropdown Menu.
- Dimension did not expose a separate global approval queue for Auto-off skill review; Alfred can keep safer explicit approvals.

## `/library` artifact archive

Evidence: `screenshots/07-library-empty.png`, `screenshots/07b-library-types-menu.png`, `screenshots/15-library-populated.png`, `screenshots/15b-library-artifact-viewer.png`, `snapshots/library.txt`, `snapshots/library-types-menu.txt`.

DOM target:

```tsx
<LibraryRoute>
  <PageHeader align="center" title="Library" subtitle="Browse all your created artifacts." />
  <Toolbar>
    <Tabs.Root value={filter}>
      <Tabs.Trigger value="all">All Types</Tabs.Trigger>
      <Tabs.Trigger value="favourites">Favourites</Tabs.Trigger>
    </Tabs.Root>
    <Input variant="search" />
  </Toolbar>

  <ArtifactGridOrList />
  <ArtifactViewerDialogOrPanel />
</LibraryRoute>
```

Radix/component choices:

- `All Types` is a frost pill trigger, about `107×37`, `rounded-full`.
- The type filter opens a compact `250×238`, `rounded-2xl`, blurred frost popover/dialog with combobox/listbox semantics and checkbox rows.
- Type filter menu can use Dropdown Menu or Popover; prefer Popover if it includes combobox/search behavior.
- Checked type boxes are purple (`rgb(83,59,229)`) with a small inset white glow; unchecked boxes are dark gray.
- Artifact viewer can use Dialog for standalone library open, but in chat should use the right rail panel.
- Artifact cards are plain work cards; artifact pages/content use `FrostPanel`/iframe wrappers.

## `/settings`

Evidence: `screenshots/08-settings-user.png`, `screenshots/08b-settings-features.png`, `screenshots/08c-settings-preferences.png`, `snapshots/settings-user.txt`, `snapshots/settings-features.txt`, `snapshots/settings-preferences.txt`.

DOM target:

```tsx
<SettingsRoute>
  <PageHeader align="left" title="Settings" />
  <div className="settings-grid">
    <nav aria-label="Settings sections">
      <SettingsSectionButton value="user">User</SettingsSectionButton>
      <SettingsSectionButton value="billing">Billing</SettingsSectionButton>
      <SettingsSectionButton value="plan">Plan</SettingsSectionButton>
      <SettingsSectionButton value="features">Features</SettingsSectionButton>
      <SettingsSectionButton value="preferences">Preferences</SettingsSectionButton>
      <SettingsSectionButton value="referrals">Referrals</SettingsSectionButton>
    </nav>

    <PanelCard>
      <SectionHeader />
      <FieldRow />
      <SwitchRows />
      <ThemePillTabs />
      <DangerActions />
    </PanelCard>
  </div>
</SettingsRoute>
```

Build notes:

- Settings title is left-aligned; most other route titles are centered.
- Inner nav is vertical on desktop and horizontal-scroll on mobile.
- Live section nav rows are about `176×28`, `py-1`, icon + label, `14px` medium text; active row is near-white, inactive row is muted gray.
- Panel is a subdued `rounded-2xl` card with small field rows.
- Mode choices are pill tabs about `32px` tall with `role="tab"` semantics. Preference toggles are Switch rows; off state is `44×24`, rounded-full, dark gray with frost border.

## Search / command palette

Evidence: `screenshots/11-search-palette.png`, `snapshots/search-palette.txt`.

DOM target:

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent srOnlyHeader title="Search">
    <Command>
      <CommandInput />
      <CommandList>
        <CommandGroup heading="Actions">
          <CommandItem />
        </CommandGroup>
        <CommandGroup heading="Navigate">
          <CommandItem />
        </CommandGroup>
      </CommandList>
      <CommandLegend />
    </Command>
  </DialogContent>
</Dialog>
```

Build notes:

- Already implemented locally as `CommandPalette`.
- Dialog material is `frost-popover`, `rounded-3xl`, blurred overlay.
- Result rows use leading icon tile and trailing `Kbd`.

## Connect tools modal

Evidence: `screenshots/33-connect-tools-modal-2026-05-18.png`, `snapshots/connect-tools-modal-2026-05-18.txt`.

DOM target:

```tsx
<Dialog>
  <DialogContent title="Connect Your Tools">
    <Input variant="search" />
    <IntegrationCatalog compact />
  </DialogContent>
</Dialog>
```

Build notes:

- Reuse the same provider metadata as `/integrations`.
- Row actions are `Connect`, `Manage`, or disabled `Coming Soon`.
- Keep this as a modal because it is invoked from the composer row.

## Composer `@` mention menu

Evidence: `screenshots/37-composer-at-mention-menu-2026-05-18.png`, `screenshots/38-composer-at-mention-filter-g-2026-05-18.png`, `screenshots/39-composer-at-mention-inserted-2026-05-18.png`.

DOM target:

```tsx
<RichComposer>
  <EditorContent />
  <Popover open={mentionOpen}>
    <Popover.Anchor virtualRef={caretRect} />
    <Popover.Content className="frost-popover rounded-2xl p-2 max-w-[19rem]">
      <MentionRow selected />
      <MentionRow />
    </Popover.Content>
  </Popover>
</RichComposer>
```

Build notes:

- Dimension uses TipTap/ProseMirror; Alfred textarea can only approximate visually.
- Keyboard loop: `@` opens, query filters, ArrowUp/Down changes active row, Enter/Tab inserts, Escape closes.
- Inserted mention renders as a small purple pill with provider icon and serialized item data.
- Backend should receive structured mention IDs, not only rendered text.

## Implementation checklist

1. Add Radix wrappers for Checkbox, Popover, Dropdown Menu, Tooltip.
2. Decide whether to migrate local Tabs/Switch to Radix for parity or keep current visual components.
3. Extract composer, model picker, connect-tools row, and quick rail from `routes/index.tsx`.
4. Build route surfaces using the DOM targets above before tuning per-pixel CSS.
5. Verify each route against the archived screenshot and a11y snapshot at desktop and mobile widths.
