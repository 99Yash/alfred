import * as Popover from "@radix-ui/react-popover";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  AtSign,
  Check,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileUp,
  Link2,
  Mic,
  Plus,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Video,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { LandingPage } from "~/components/landing/landing-page";
import { ConnectToolsDialog } from "~/components/connect-tools-dialog";
import {
  DimensionComposerContextMenu,
  DimensionComposerIconButton,
  DimensionComposerOverflowMenu,
  DimensionComposerSendButton,
  DimensionComposerShell,
  DimensionComposerToolbar,
  DimensionModelPicker,
  type DimensionComposerMenuItem,
  type DimensionModelOption,
} from "~/components/dimension-composer-shell";
import { QuickAccessRail } from "~/components/quick-access-rail";
import { WeatherVideoSurface } from "~/components/weather-video-surface";
import { authClient } from "~/lib/auth-client";
import { useRightRail } from "~/lib/app-shell";
import { client } from "~/lib/eden";
import { IntegrationGlyph, IntegrationIcon, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: () => client.health.get(),
    staleTime: 30_000,
  });

  const name = displayName(session?.user);
  const now = useNow();
  const greeting = useMemo(() => greetingFor(now), [now]);
  const longDate = useMemo(() => formatLongDate(now), [now]);

  const healthOk = Boolean(health?.data && "ok" in health.data && health.data.ok);

  // Right-rail widget — date / status / quick suggestions placeholder. Memoize
  // the node so its identity is stable while deps haven't changed — otherwise
  // we'd loop the AppShell state on every render.
  const rightRail = useMemo(
    () =>
      session?.user ? <QuickAccessRail healthOk={healthOk} healthLoading={healthLoading} /> : null,
    [session?.user, healthOk, healthLoading],
  );
  useRightRail(rightRail);

  // Logged out — Dimension-grammar marketing landing (single-user, every CTA
  // points to /login). The full chat shell renders below for signed-in users.
  if (!sessionPending && !session?.user) {
    return <LandingPage healthOk={healthOk} healthLoading={healthLoading} />;
  }

  return (
    <div className="relative min-h-[100dvh] flex flex-col">
      {/* Top spacer to keep the mobile hamburger from colliding with the title */}
      <div className="md:hidden h-14 shrink-0" />

      <div className="flex-1 grid place-items-center px-4 sm:px-6 lg:px-10">
        <div className="w-full max-w-[688px] space-y-4 -mt-16 md:-mt-8">
          <header className="text-center space-y-2">
            <p className="text-lg tracking-tight text-white/50">{longDate}</p>
            <h1
              className={cn(
                "text-balance text-3xl font-normal tracking-tight sm:text-4xl pb-1",
                "bg-clip-text text-transparent",
                "bg-gradient-to-b from-white to-white/60",
              )}
            >
              {greeting}, {name}
            </h1>
          </header>

          <Composer />
          <UpcomingMeeting />
        </div>
      </div>

      <div className="hidden md:block pointer-events-none absolute inset-x-0 bottom-6 px-10">
        <div className="pointer-events-auto mx-auto w-full max-w-[688px]">
          <SetupNudge />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type MentionItem = {
  id: string;
  label: string;
  aliases: string[];
  brand: IntegrationBrand;
  connected?: boolean;
};

type ApprovalMode = "manual" | "auto";
type ReviewPreviewStatus = "pending" | "auto" | "approved" | "rejected";

type ReviewPreview = {
  id: number;
  prompt: string;
  mode: ApprovalMode;
  mentions: MentionItem[];
  status: ReviewPreviewStatus;
};

const MENTION_ITEMS: MentionItem[] = [
  {
    id: "collaborators",
    label: "Collaborators",
    aliases: ["people", "teammates", "users"],
    brand: "collaborators",
  },
  {
    id: "github",
    label: "GitHub",
    aliases: ["gh", "repo", "repos", "pull request", "issue"],
    brand: "github",
  },
  {
    id: "gmail",
    label: "Gmail",
    aliases: ["mail", "email", "inbox"],
    brand: "gmail",
    connected: true,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    aliases: ["calendar", "meetings", "events"],
    brand: "google_calendar",
    connected: true,
  },
  {
    id: "google_drive",
    label: "Google Drive",
    aliases: ["drive", "files"],
    brand: "google_drive",
    connected: true,
  },
  {
    id: "google_docs",
    label: "Google Docs",
    aliases: ["docs", "documents"],
    brand: "google_docs",
  },
  {
    id: "google_sheets",
    label: "Google Sheets",
    aliases: ["sheets", "spreadsheet", "spreadsheets"],
    brand: "google_sheets",
  },
  {
    id: "google_slides",
    label: "Google Slides",
    aliases: ["slides", "presentation", "deck"],
    brand: "google_slides",
  },
  {
    id: "linear",
    label: "Linear",
    aliases: ["issues", "tickets", "projects"],
    brand: "linear",
  },
  {
    id: "slack",
    label: "Slack",
    aliases: ["messages", "channels", "chat"],
    brand: "slack",
  },
  {
    id: "web",
    label: "Web",
    aliases: ["browser", "search", "internet"],
    brand: "web",
  },
];

const MENTION_LISTBOX_ID = "composer-mention-listbox";
const MODEL_OPTIONS = [
  {
    id: "alfred",
    label: "Alfred",
    description: "Fast default routing for everyday work",
  },
  {
    id: "alfred-pro",
    label: "Alfred Pro",
    description: "Deeper reasoning for complex planning",
  },
];

function mentionOptionId(item: MentionItem) {
  return `composer-mention-option-${item.id}`;
}

/**
 * Mention menu state. Groups everything that has to change together when the
 * user types `@` — the menu visibility, the query, the selected option, and
 * the caret offset where the token begins. Centralising the transitions in a
 * reducer eliminates the prior chain of useStates + tracking refs.
 */
interface MentionState {
  open: boolean;
  query: string;
  selectedIndex: number;
  start: number | null;
}

type MentionAction =
  | { type: "open"; start: number }
  | { type: "close" }
  | { type: "set-query"; start: number; query: string }
  | { type: "set-index"; index: number }
  | { type: "next"; total: number }
  | { type: "prev"; total: number };

const INITIAL_MENTION_STATE: MentionState = {
  open: false,
  query: "",
  selectedIndex: 0,
  start: null,
};

function mentionReducer(state: MentionState, action: MentionAction): MentionState {
  switch (action.type) {
    case "open":
      return { open: true, query: "", selectedIndex: 0, start: action.start };
    case "close":
      return INITIAL_MENTION_STATE;
    case "set-query":
      // Query change resets the selected index — the previous selection no
      // longer aligns with the new filtered list.
      return {
        open: true,
        query: action.query,
        selectedIndex: state.query === action.query ? state.selectedIndex : 0,
        start: action.start,
      };
    case "set-index":
      return { ...state, selectedIndex: action.index };
    case "next":
      return {
        ...state,
        selectedIndex: action.total === 0 ? 0 : (state.selectedIndex + 1) % action.total,
      };
    case "prev":
      return {
        ...state,
        selectedIndex:
          action.total === 0 ? 0 : (state.selectedIndex - 1 + action.total) % action.total,
      };
  }
}

interface ComposerSettings {
  approvalMode: ApprovalMode;
  model: string;
}

type ComposerSettingsAction =
  | { type: "set-approval-mode"; mode: ApprovalMode }
  | { type: "set-model"; model: string };

function composerSettingsReducer(
  state: ComposerSettings,
  action: ComposerSettingsAction,
): ComposerSettings {
  switch (action.type) {
    case "set-approval-mode":
      return { ...state, approvalMode: action.mode };
    case "set-model":
      return { ...state, model: action.model };
  }
}

function Composer() {
  const [value, setValue] = useState("");
  const [settings, dispatchSettings] = useReducer(composerSettingsReducer, {
    approvalMode: "manual",
    model: "alfred",
  });
  const [connectToolsOpen, setConnectToolsOpen] = useState(false);
  const [reviewPreview, setReviewPreview] = useState<ReviewPreview | null>(null);
  const [mention, dispatchMention] = useReducer(mentionReducer, INITIAL_MENTION_STATE);
  const approvalMode = settings.approvalMode;
  const model = settings.model;
  const setApprovalMode = useCallback(
    (mode: ApprovalMode) => dispatchSettings({ type: "set-approval-mode", mode }),
    [],
  );
  const setModel = useCallback(
    (next: string) => dispatchSettings({ type: "set-model", model: next }),
    [],
  );

  const hasContent = value.trim().length > 0;
  const filteredMentions = useMemo(() => filterMentions(mention.query), [mention.query]);
  // Clamp during render so we never index past the filtered list.
  const safeMentionIndex =
    filteredMentions.length === 0
      ? 0
      : Math.min(mention.selectedIndex, filteredMentions.length - 1);
  const modelOptions = useMemo(
    () =>
      MODEL_OPTIONS.map((option) => ({
        ...option,
        selected: option.id === model,
      })),
    [model],
  );

  const syncMentionState = useCallback((editor: Editor) => {
    const nextValue = editor.getText();
    const caret = editorCaretTextOffset(editor);
    const token = activeMentionToken(nextValue, caret);
    if (!token) {
      dispatchMention({ type: "close" });
      return;
    }
    dispatchMention({ type: "set-query", start: token.start, query: token.query });
  }, []);

  // Latest keydown closure kept in a ref so TipTap's handleKeyDown — which
  // is registered once at editor init — always sees the current state.
  const handleEditorKeyDownRef = useRef<(event: KeyboardEvent) => boolean>(() => false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: "Type and press enter to start chatting...",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        "aria-autocomplete": "list",
        "aria-controls": MENTION_LISTBOX_ID,
        "aria-label": "Message",
        class:
          "tiptap ProseMirror tiptap-minimum-input composer-editor min-h-[50px] max-h-[320px] overflow-y-auto bg-transparent px-3 pb-2 pt-3 text-sm leading-6 text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35",
      },
      handleKeyDown: (_view, event) => handleEditorKeyDownRef.current(event),
    },
    onSelectionUpdate: ({ editor }) => syncMentionState(editor),
    onUpdate: ({ editor }) => {
      setValue(editor.getText());
      syncMentionState(editor);
    },
  });

  const send = () => {
    const prompt = editor?.getText().trim() ?? "";
    if (!prompt) return;
    const mentions = detectMentions(prompt);

    setReviewPreview({
      id: Date.now(),
      prompt,
      mode: approvalMode,
      mentions,
      status: approvalMode === "auto" ? "auto" : "pending",
    });

    // Stubbed until m13 lands the chat surface.
    // eslint-disable-next-line no-console
    console.info("[alfred] composer submit:", {
      prompt,
      approvalMode,
      mentions: mentions.map((item) => item.id),
    });
    editor?.commands.clearContent();
    setValue("");
    dispatchMention({ type: "close" });
    queueMicrotask(() => editor?.commands.focus());
  };

  const insertMention = useCallback(
    (item: MentionItem) => {
      if (!editor) return;
      const caret = editorCaretTextOffset(editor);
      const start = mention.start ?? activeMentionToken(value, caret)?.start;
      if (start == null) return;

      editor
        .chain()
        .focus()
        .deleteRange({
          from: textOffsetToPMPos(value, start),
          to: textOffsetToPMPos(value, caret),
        })
        .insertContent(`@${item.label} `)
        .run();
      dispatchMention({ type: "close" });
    },
    [editor, value, mention.start],
  );

  const openMentionMenu = useCallback(() => {
    if (!editor) return;
    const caret = editorCaretTextOffset(editor);
    const spacer = caret > 0 && !/\s/.test(value.charAt(caret - 1)) ? " " : "";

    editor.chain().focus().insertContent(`${spacer}@`).run();
    dispatchMention({ type: "open", start: caret + spacer.length });
  }, [editor, value]);

  const updateReviewPreview = useCallback((status: ReviewPreviewStatus) => {
    setReviewPreview((preview) => (preview ? { ...preview, status } : preview));
  }, []);

  const contextItems: DimensionComposerMenuItem[] = useMemo(
    () => [
      {
        label: "Mention a tool",
        description: "Search connected apps and sources",
        icon: <AtSign size={15} />,
        onSelect: openMentionMenu,
      },
      {
        label: "Connect tools",
        description: "Bring Gmail, Calendar, Drive, and more",
        icon: <Link2 size={15} />,
        onSelect: () => setConnectToolsOpen(true),
      },
      {
        label: "Upload file",
        description: "Coming with artifact ingestion",
        icon: <FileUp size={15} />,
        disabled: true,
      },
    ],
    [openMentionMenu],
  );
  const overflowItems: DimensionComposerMenuItem[] = useMemo(
    () => [
      {
        label: approvalMode === "auto" ? "Switch to manual review" : "Switch to auto mode",
        description:
          approvalMode === "auto" ? "Ask before durable changes" : "Let Alfred proceed locally",
        icon: <ShieldCheck size={15} />,
        onSelect: () => setApprovalMode(approvalMode === "auto" ? "manual" : "auto"),
      },
      {
        label: "Composer settings",
        description: "Review gates, integrations, preferences",
        icon: <Settings2 size={15} />,
        href: "/settings",
      },
    ],
    [approvalMode],
  );

  // Keep the keydown closure fresh — TipTap registers the handler once at
  // editor init, so we route it through a ref that we overwrite each render
  // with a closure over the current state. Returns true when we handled the
  // event so TipTap skips its own keymap.
  handleEditorKeyDownRef.current = (event) => {
    if (mention.open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        dispatchMention({ type: "next", total: filteredMentions.length });
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        dispatchMention({ type: "prev", total: filteredMentions.length });
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = filteredMentions[safeMentionIndex];
        event.preventDefault();
        if (item) insertMention(item);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dispatchMention({ type: "close" });
        return true;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
      return true;
    }
    return false;
  };

  const onMentionOpenChange = useCallback((open: boolean) => {
    if (!open) dispatchMention({ type: "close" });
  }, []);
  const onMentionHover = useCallback(
    (index: number) => dispatchMention({ type: "set-index", index }),
    [],
  );

  return (
    <div className="space-y-3">
      <Popover.Root open={mention.open} onOpenChange={onMentionOpenChange}>
        <Popover.Anchor asChild>
          <div>
            <DimensionComposerShell
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              tray={<ConnectedToolsRow onOpen={() => setConnectToolsOpen(true)} />}
              toolbar={
                <ComposerToolbar
                  contextItems={contextItems}
                  overflowItems={overflowItems}
                  approvalMode={approvalMode}
                  onApprovalModeChange={setApprovalMode}
                  model={model}
                  modelOptions={modelOptions}
                  onModelChange={setModel}
                  hasContent={hasContent}
                />
              }
            >
              <EditorContent editor={editor} />
            </DimensionComposerShell>
          </div>
        </Popover.Anchor>
        <MentionPopoverContent
          items={filteredMentions}
          selectedIndex={safeMentionIndex}
          query={mention.query}
          onSelect={insertMention}
          onHover={onMentionHover}
        />
      </Popover.Root>

      {reviewPreview ? (
        <RunReviewPreview
          preview={reviewPreview}
          onApprove={() => updateReviewPreview("approved")}
          onReject={() => updateReviewPreview("rejected")}
          onDismiss={() => setReviewPreview(null)}
        />
      ) : null}
      <ConnectToolsDialog open={connectToolsOpen} onOpenChange={setConnectToolsOpen} />
    </div>
  );
}

/**
 * The toolbar's start (context menu + approval toggle + status pill) and end
 * (model picker + overflow menu + voice button + send) are presentational
 * compositions of DimensionComposer* primitives. Keeping them out of Composer
 * keeps the parent focused on state orchestration.
 */
function ComposerToolbar({
  contextItems,
  overflowItems,
  approvalMode,
  onApprovalModeChange,
  model,
  modelOptions,
  onModelChange,
  hasContent,
}: {
  contextItems: DimensionComposerMenuItem[];
  overflowItems: DimensionComposerMenuItem[];
  approvalMode: ApprovalMode;
  onApprovalModeChange: (next: ApprovalMode) => void;
  model: string;
  modelOptions: DimensionModelOption[];
  onModelChange: (id: string) => void;
  hasContent: boolean;
}) {
  return (
    <DimensionComposerToolbar
      start={
        <>
          <DimensionComposerContextMenu items={contextItems}>
            <Plus size={15} />
          </DimensionComposerContextMenu>
          <ApprovalModeToggle mode={approvalMode} onModeChange={onApprovalModeChange} />
          <ComposerStatusPill />
        </>
      }
      end={
        <>
          <DimensionModelPicker
            value={MODEL_OPTIONS.find((option) => option.id === model)?.label ?? "Alfred"}
            options={modelOptions}
            onSelect={onModelChange}
          />
          <DimensionComposerOverflowMenu items={overflowItems} />
          <DimensionComposerIconButton label="Voice input" disabled>
            <Mic size={15} />
          </DimensionComposerIconButton>
          <DimensionComposerSendButton disabled={!hasContent} />
        </>
      }
    />
  );
}

/**
 * Portal'd mention menu — kept in its own component so the Composer body
 * stays focused on state orchestration. The Radix outside-click/auto-focus
 * suppressions live here because the editor that drives the menu lives in
 * the Popover.Anchor, not inside the content.
 */
function MentionPopoverContent({
  items,
  selectedIndex,
  query,
  onSelect,
  onHover,
}: {
  items: MentionItem[];
  selectedIndex: number;
  query: string;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  return (
    <Popover.Portal>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
        className="z-20 outline-none"
      >
        <MentionMenu
          items={items}
          selectedIndex={selectedIndex}
          query={query}
          onSelect={onSelect}
          onHover={onHover}
        />
      </Popover.Content>
    </Popover.Portal>
  );
}

function MentionMenu({
  items,
  selectedIndex,
  query,
  onSelect,
  onHover,
}: {
  items: MentionItem[];
  selectedIndex: number;
  query: string;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, items.length]);

  return (
    <div
      className={cn(
        "frost-popover w-[19rem] max-w-[calc(100vw-2rem)] rounded-2xl p-2",
        "animate-menu-pop-in origin-bottom-left",
      )}
    >
      <div
        id={MENTION_LISTBOX_ID}
        role="listbox"
        aria-label="Mentionable tools and integrations"
        className="max-h-80 overflow-y-auto scrollbar scroll-py-2"
      >
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm font-medium text-white/86">No matches</p>
            <p className="mt-1 text-[12px] text-white/50">No integration matches @{query}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {items.map((item, index) => (
              <MentionMenuItem
                key={item.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                item={item}
                selected={index === selectedIndex}
                onMouseEnter={() => onHover(index)}
                onSelect={() => onSelect(item)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface MentionMenuItemProps {
  item: MentionItem;
  selected: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
  ref?: (node: HTMLDivElement | null) => void;
}

function MentionMenuItem({ item, selected, onMouseEnter, onSelect, ref }: MentionMenuItemProps) {
  return (
    <div
      ref={ref}
      id={mentionOptionId(item)}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseEnter={onMouseEnter}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      data-selected={selected}
      className={cn(
        "cursor-default",
        "mention-menu-row group flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2 py-2",
        "text-left text-sm text-white/86 outline-none",
        "transition-[background-color,box-shadow,color]",
        !selected && "hover:bg-white/[0.055]",
      )}
    >
      <IntegrationIcon brand={item.brand} connected={item.connected} size="sm" variant="frost" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </div>
  );
}

function ApprovalModeToggle({
  mode,
  onModeChange,
}: {
  mode: ApprovalMode;
  onModeChange: (mode: ApprovalMode) => void;
}) {
  const isAuto = mode === "auto";

  return (
    <button
      type="button"
      aria-pressed={isAuto}
      title={
        isAuto
          ? "Auto approve internal skill and workflow changes"
          : "Ask for human review before internal changes"
      }
      onClick={() => onModeChange(isAuto ? "manual" : "auto")}
      className={cn(
        "group/auto inline-flex h-8 min-w-[72px] items-center justify-center gap-1.5 px-3",
        "rounded-[10px] outline-none backdrop-blur-sm",
        "text-[13px] font-normal text-white/86",
        "transition-[opacity,filter] hover:opacity-90 active:opacity-80",
        "focus-visible:ring-2 focus-visible:ring-white/20",
        isAuto
          ? "bg-[linear-gradient(180deg,#141414_0%,rgba(20,20,20,0.5)_100%)]"
          : "bg-[linear-gradient(180deg,#0f0f0f_0%,#1e1e1e_100%)]",
      )}
    >
      <span>Auto</span>
      <span
        aria-hidden
        className={cn(
          "inline-block size-2.5 rounded-full transition-[background-color,box-shadow]",
          isAuto
            ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55),inset_0_1px_0_rgba(255,255,255,0.4)]"
            : "bg-white/[0.18] shadow-[inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.35)]",
        )}
      />
    </button>
  );
}

function ComposerStatusPill() {
  return (
    <a
      href="/settings"
      className={cn(
        "hidden h-8 items-center gap-2 rounded-[10px] px-3 sm:inline-flex",
        "border border-white/[0.07] bg-[linear-gradient(180deg,rgba(84,22,22,0.72)_0%,rgba(16,16,16,0.86)_100%)]",
        "text-[13px] text-white/70 outline-none backdrop-blur-sm",
        "shadow-[inset_0_0_9px_rgba(255,255,255,0.06),0_2px_8px_rgba(0,0,0,0.18)]",
        "transition-[filter,color] hover:text-white hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white/20",
      )}
    >
      <CircleAlert size={15} className="text-red-400" strokeWidth={2.2} />
      <span className="truncate">Review gates active</span>
      <span className="font-medium text-purple-300">Configure</span>
    </a>
  );
}

function RunReviewPreview({
  preview,
  onApprove,
  onReject,
  onDismiss,
}: {
  preview: ReviewPreview;
  onApprove: () => void;
  onReject: () => void;
  onDismiss: () => void;
}) {
  const isAuto = preview.mode === "auto";
  const items = inferApprovalItems(preview.prompt);
  const header =
    preview.status === "approved"
      ? "Approved for this preview"
      : preview.status === "rejected"
        ? "Manual gate kept"
        : isAuto
          ? "Auto approval path"
          : "Human review path";
  const HeaderIcon =
    preview.status === "approved"
      ? Check
      : preview.status === "rejected"
        ? CircleAlert
        : isAuto
          ? ShieldCheck
          : Clock3;
  const headerTone =
    preview.status === "approved"
      ? "text-emerald-200"
      : preview.status === "rejected"
        ? "text-amber-200"
        : isAuto
          ? "text-emerald-200"
          : "text-amber-200";

  return (
    <div className="animate-menu-pop-in space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-2xl bg-[#101010]/92 px-4 py-2.5 text-left text-[13px] leading-relaxed text-white/85 shadow-soft ring-1 ring-white/10">
          {preview.prompt}
        </div>
      </div>

      <div className="frost-panel rounded-[20px] p-3 text-white">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "frost-icon-tile mt-0.5 grid size-8 shrink-0 place-items-center rounded-2xl",
              headerTone,
            )}
          >
            <HeaderIcon size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{header}</p>
              <span className="frost-badge rounded-full px-2 py-0.5 text-[11px] text-white/65">
                {isAuto ? "Alfred decides" : "Needs review"}
              </span>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-white/58">
              {isAuto
                ? "Alfred can carry low-risk internal changes forward, while external side effects still stop for review."
                : "Alfred should propose the internal changes and wait before creating or updating durable behavior."}
            </p>

            {preview.mentions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.mentions.map((item) => {
                  return (
                    <span
                      key={item.id}
                      className="frost-badge inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-white/62"
                    >
                      <IntegrationGlyph brand={item.brand} size={11} variant="frost" />@{item.label}
                    </span>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 divide-y divide-white/[0.08] overflow-hidden rounded-2xl bg-black/25 ring-1 ring-white/10">
          {items.map((item) => (
            <ApprovalActionRow key={item.kind} item={item} preview={preview} />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-white/48">Saved as a local run preview.</p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onDismiss}
              className="h-8 rounded-md px-2.5 text-[12px] text-white/58 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              Dismiss
            </button>
            {preview.status === "pending" ? (
              <>
                <button
                  type="button"
                  onClick={onReject}
                  className="h-8 rounded-md border border-white/10 bg-white/[0.045] px-2.5 text-[12px] text-white/64 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  Keep manual
                </button>
                <button
                  type="button"
                  onClick={onApprove}
                  className="h-8 rounded-md bg-white px-2.5 text-[12px] font-medium text-black transition-[background-color,transform] hover:bg-white/90 active:scale-[0.96]"
                >
                  Approve internal plan
                </button>
              </>
            ) : null}
            {preview.status === "auto" ? (
              <>
                <button
                  type="button"
                  onClick={onReject}
                  className="h-8 rounded-md border border-white/10 bg-white/[0.045] px-2.5 text-[12px] text-white/64 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  Require review
                </button>
                <button
                  type="button"
                  onClick={onApprove}
                  className="h-8 rounded-md bg-white px-2.5 text-[12px] font-medium text-black transition-[background-color,transform] hover:bg-white/90 active:scale-[0.96]"
                >
                  Confirm auto path
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

type ApprovalItem = {
  kind: "skill" | "workflow" | "external" | "run";
  title: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};

function ApprovalActionRow({ item, preview }: { item: ApprovalItem; preview: ReviewPreview }) {
  const Icon = item.icon;
  const isExternal = item.kind === "external";
  const status = approvalStatusFor(item, preview);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-white">
      <span className="frost-icon-tile grid size-7 shrink-0 place-items-center rounded-xl text-white/58">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{item.title}</p>
        <p className="truncate text-[12px] text-white/52">{item.description}</p>
      </div>
      <span
        className={cn(
          "frost-badge shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
          isExternal
            ? "text-sky-200"
            : preview.status === "approved"
              ? "text-emerald-200"
              : "text-white/58",
        )}
      >
        {status}
      </span>
    </div>
  );
}

function detectMentions(text: string) {
  const lower = text.toLowerCase();
  return MENTION_ITEMS.filter((item) => lower.includes(`@${item.label.toLowerCase()}`));
}

function inferApprovalItems(prompt: string): ApprovalItem[] {
  const lower = prompt.toLowerCase();
  const items: ApprovalItem[] = [];

  if (/\b(skill|learn|remember|memory|preference|always|tone|style)\b/.test(lower)) {
    items.push({
      kind: "skill",
      title: "Skill or memory update",
      description: "Create durable instructions from the request",
      icon: Sparkles,
    });
  }

  if (/\b(workflow|automation|automate|schedule|daily|weekly|hourly|trigger|when)\b/.test(lower)) {
    items.push({
      kind: "workflow",
      title: "Workflow change",
      description: "Create or update a recurring agent behavior",
      icon: Workflow,
    });
  }

  if (/\b(send|email|gmail|calendar|invite|slack|message|post|delete|cancel)\b/.test(lower)) {
    items.push({
      kind: "external",
      title: "External action",
      description: "Outbound or destructive effects require review",
      icon: ShieldAlert,
    });
  }

  if (items.length === 0) {
    items.push({
      kind: "run",
      title: "Agent run",
      description: "Alfred can plan the request and choose tools",
      icon: ClipboardCheck,
    });
  }

  return items;
}

function approvalStatusFor(item: ApprovalItem, preview: ReviewPreview) {
  if (item.kind === "external") return "Human gate";
  if (preview.status === "approved") return "Approved";
  if (preview.status === "rejected") return "Manual";
  if (preview.status === "auto") return "Auto eligible";
  return "Review";
}

function ConnectedToolsRow({ onOpen }: { onOpen: () => void }) {
  const tools: IntegrationBrand[] = [
    "gmail",
    "google_calendar",
    "google_drive",
    "google_docs",
    "google_sheets",
    "google_slides",
    "github",
    "linear",
    "slack",
    "web",
  ];

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative mx-auto -mb-px -mt-px flex h-[46px] w-[calc(100%-32px)] items-center justify-between gap-3 rounded-b-2xl",
        "border-t border-white/[0.055] bg-black/[0.08] px-4 pt-3.5 pb-3 text-[13px] text-white/42 outline-none",
        "transition-colors hover:text-white",
        "focus-visible:ring-2 focus-visible:ring-white/[0.18]",
      )}
    >
      <span className="min-w-0 truncate font-normal transition-colors group-hover:text-white/86">
        Connect Your Tools
      </span>
      <span className="flex shrink-0 items-center gap-[3px]">
        {tools.map((brand) => (
          <IntegrationGlyph
            key={brand}
            brand={brand}
            size={16}
            variant="plain"
            className="opacity-75 transition-opacity group-hover:opacity-100"
          />
        ))}
      </span>
    </button>
  );
}

function UpcomingMeeting() {
  return (
    <section className="mx-auto hidden w-full max-w-[656px] pt-7 text-white/90 md:block">
      <p className="text-[13px] font-semibold uppercase tracking-[0.04em] text-white/58">
        Upcoming Meeting
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Video size={15} className="shrink-0 text-white/58" />
        <p className="min-w-0 flex-1 truncate text-base leading-6">
          Eng standup <span className="px-2 text-white/45">•</span>
          <span className="text-white/86">10:00 AM - 11:00 AM</span>
        </p>
        <a
          href="/integrations"
          className={cn(
            "inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4",
            "bg-white/[0.055] text-sm text-white/90 outline-none",
            "transition-colors hover:bg-white/[0.085] focus-visible:ring-2 focus-visible:ring-white/20",
          )}
        >
          <IntegrationGlyph brand="google_calendar" size={18} variant="plain" />
          Join
        </a>
      </div>
    </section>
  );
}

function SetupNudge() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "group relative block h-[74px] w-full overflow-hidden rounded-3xl px-4 text-left shadow-pop",
          "text-white ring-1 ring-white/10 outline-none",
          "transition-[box-shadow,transform]",
          "hover:shadow-[0_18px_46px_rgba(0,0,0,0.38)] hover:ring-white/[0.16]",
          "focus-visible:ring-2 focus-visible:ring-white/[0.24] active:scale-[0.99]",
        )}
      >
        <WeatherVideoSurface />
        <span className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.18),rgba(0,0,0,0.54))] transition-opacity group-hover:opacity-90" />
        <span className="relative flex h-full items-center justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Connect tools for live context</span>
            <span className="mt-0.5 block truncate text-[12px] text-white/70">
              Bring Gmail, Calendar, Drive, and code sources into Alfred.
            </span>
          </span>
          <span
            className={cn(
              "shrink-0 inline-flex items-center gap-1.5 rounded-full px-4 py-2",
              "text-[13px] font-medium text-black backdrop-blur-sm",
              "bg-[linear-gradient(180deg,rgba(255,255,255,0.85)_0%,#eeeeee_100%)]",
              "shadow-[inset_0_0_7px_1px_rgba(255,255,255,0.16),0_0_0_1px_rgba(0,0,0,0.08)]",
              "transition-[filter,box-shadow]",
              "group-hover:shadow-[inset_0_0_8px_1px_rgba(255,255,255,0.28),0_0_0_1px_rgba(0,0,0,0.08),0_2px_12px_rgba(255,255,255,0.18)]",
            )}
          >
            Connect
            <ArrowRight size={14} strokeWidth={2.25} />
          </span>
        </span>
      </button>
      <ConnectToolsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function displayName(user: SessionUser | null | undefined): string {
  if (!user) return "there";
  if (user.name && user.name.trim().length > 0) {
    const first = user.name.trim().split(/\s+/)[0];
    if (first) return capitalize(first);
  }
  if (user.email) {
    const local = user.email.split("@")[0];
    if (local && local.length > 0) {
      return (
        local
          .replace(/[._-]+/g, " ")
          .split(" ")
          .flatMap((word) => {
            const capped = capitalize(word);
            return capped ? [capped] : [];
          })
          .join(" ") || local
      );
    }
  }
  return "there";
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function filterMentions(query: string): MentionItem[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return MENTION_ITEMS;
  return MENTION_ITEMS.filter((item) => {
    const haystack = [item.label, ...item.aliases].join(" ").toLowerCase();
    return haystack.includes(normalized);
  });
}

function activeMentionToken(value: string, caret: number): { start: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const start = beforeCaret.lastIndexOf("@");
  if (start < 0) return null;
  const charBefore = start === 0 ? "" : value[start - 1];
  if (charBefore && !/\s/.test(charBefore)) return null;

  const query = beforeCaret.slice(start + 1);
  if (/[\s@]/.test(query)) return null;
  return { start, query };
}

function editorCaretTextOffset(editor: Editor): number {
  return editor.state.doc.textBetween(0, editor.state.selection.from, "\n", "\n").length;
}

// textBetween renders each block boundary as a single "\n" (1 text char), but ProseMirror
// uses 2 positions per boundary (close + open). Each newline before the offset adds 1 to
// the PM position; the leading +1 lands inside the first paragraph's content.
function textOffsetToPMPos(value: string, textOffset: number): number {
  const slice = value.slice(0, textOffset);
  let newlines = 0;
  for (let i = 0; i < slice.length; i++) if (slice.charCodeAt(i) === 10) newlines++;
  return textOffset + 1 + newlines;
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Up Late";
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  if (hour < 21) return "Good Evening";
  return "Good Night";
}

function formatLongDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "long" });
  const day = date.getDate();
  return `${weekday}, ${month} ${day}${ordinalSuffix(day)}`;
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Re-ticks the "now" reference every minute so the greeting transitions
 * (morning → afternoon → evening) even if the tab stays open across the
 * boundary. Cheap; no animation, just a re-render.
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
