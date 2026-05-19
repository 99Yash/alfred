import * as AccordionPrimitive from "@radix-ui/react-accordion";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AtSign,
  Bot,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  FileText,
  FileUp,
  Link2,
  Maximize2,
  Mic,
  PanelRightOpen,
  Plus,
  Settings2,
  Share2,
  ThumbsUp,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import {
  DimensionComposerContextMenu,
  DimensionComposerIconButton,
  DimensionComposerOverflowMenu,
  DimensionComposerSendButton,
  DimensionComposerShell,
  DimensionComposerToolbar,
  DimensionModelPicker,
  type DimensionComposerMenuItem,
} from "~/components/dimension-composer-shell";
import { SYCAMORE_BRIEF_PAGES } from "~/lib/artifact-pages";
import { cn } from "~/lib/utils";

type SearchResult = {
  title: string;
  domain: string;
  href: string;
};

type LocalPreviewTurn = {
  id: string;
  prompt: string;
};

const COMPANY_RESULTS: SearchResult[] = [
  {
    title: "Company funding announcement",
    domain: "businesswire.com",
    href: "https://www.businesswire.com/",
  },
  {
    title: "Company profile",
    domain: "linkedin.com",
    href: "https://www.linkedin.com/",
  },
  {
    title: "About the product",
    domain: "sycamore.so",
    href: "https://sycamore.so/",
  },
  {
    title: "Recent startup coverage",
    domain: "techcrunch.com",
    href: "https://techcrunch.com/",
  },
  {
    title: "Engineering culture and roadmap",
    domain: "siliconangle.com",
    href: "https://siliconangle.com/",
  },
];

const TECH_RESULTS: SearchResult[] = [
  {
    title: "Trust architecture and enterprise agents",
    domain: "sycamore.so",
    href: "https://sycamore.so/",
  },
  {
    title: "Cloud platform and agent orchestration roles",
    domain: "greenhouse.io",
    href: "https://www.greenhouse.io/",
  },
  {
    title: "AI-native enterprise operating systems",
    domain: "company.example",
    href: "https://example.com/",
  },
  {
    title: "Multi-agent coordination patterns",
    domain: "arxiv.org",
    href: "https://arxiv.org/",
  },
];

const ROLE_RESULTS: SearchResult[] = [
  {
    title: "Careers and open roles",
    domain: "sycamore.so",
    href: "https://sycamore.so/",
  },
  {
    title: "Infrastructure engineer",
    domain: "ashbyhq.com",
    href: "https://www.ashbyhq.com/",
  },
  {
    title: "Applied AI engineer",
    domain: "jobs.example",
    href: "https://example.com/",
  },
  {
    title: "Product engineer",
    domain: "jobs.example",
    href: "https://example.com/",
  },
];

const CHAT_MODEL_OPTIONS = [
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

export function DimensionChatThread({
  showArtifactPanel = false,
}: {
  showArtifactPanel?: boolean;
}) {
  const [localTurns, setLocalTurns] = useState<LocalPreviewTurn[]>([]);

  const addLocalTurn = (prompt: string) => {
    setLocalTurns((turns) => [...turns, { id: `${Date.now()}-${turns.length}`, prompt }]);
  };

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col bg-[rgb(12,12,12)] text-gray-950">
      <ChatTopBar
        title="Sycamore Labs Interview Preparation"
        showArtifactPanel={showArtifactPanel}
      />

      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-w-0 flex-1 flex-col" aria-label="Chat thread">
          <div className="minimal-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-40 pt-4 sm:px-4">
            <div className="mx-auto max-w-5xl">
              <div className="space-y-4">
                <UserBubble>
                  I&apos;m prepping for an interview. Pull together a deeper brief on the company,
                  their technical direction, recent activity, and sharp questions to ask.
                </UserBubble>

                <AssistantTurn onPrompt={addLocalTurn} />

                <UserBubble>No need for the PDF yet. Give me one more quick lookup.</UserBubble>

                <div className="space-y-3">
                  <RunAccordion title="Gathered information" defaultOpen={false}>
                    <div className="ml-[37px]">
                      <SearchAccordion
                        query="Recent company updates"
                        resultsFound={10}
                        results={[
                          {
                            title: "Recent company update",
                            domain: "company.example",
                            href: "https://example.com/",
                          },
                          {
                            title: "Founder interview",
                            domain: "youtube.com",
                            href: "https://youtube.com/",
                          },
                        ]}
                      />
                    </div>
                  </RunAccordion>
                  <AssistantProse compact />
                  <ResponseActions />
                </div>

                {localTurns.map((turn) => (
                  <LocalPreviewTurn key={turn.id} turn={turn} />
                ))}
              </div>
            </div>
          </div>

          <ThreadComposer onSubmit={addLocalTurn} />
        </section>

        {showArtifactPanel ? <ArtifactPanel /> : null}
      </div>
    </div>
  );
}

function LocalPreviewTurn({ turn }: { turn: LocalPreviewTurn }) {
  return (
    <div className="space-y-3">
      <UserBubble>{turn.prompt}</UserBubble>
      <RunAccordion title="Drafted local preview response" defaultOpen>
        <div className="ml-[37px] space-y-3">
          <ThoughtAccordion duration="1s">
            This is a local UI preview. The real m13 runtime will replace this with persisted run
            events and tool output.
          </ThoughtAccordion>
          <ToolStatus>Prepared a response shell from the current chat context.</ToolStatus>
        </div>
      </RunAccordion>
      <div className="max-w-[900px] text-sm leading-[22px] text-gray-900">
        <p>
          I would continue from the Sycamore brief, preserve the research citations already shown,
          and turn this into the next artifact or answer once the runtime is connected.
        </p>
      </div>
      <ResponseActions />
    </div>
  );
}

function ChatTopBar({ title, showArtifactPanel }: { title: string; showArtifactPanel: boolean }) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-white/[0.045] px-3 text-sm">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-label="Thread actions"
          className="grid size-7 place-items-center rounded-lg text-gray-700 transition-colors hover:bg-white/[0.055] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/40"
        >
          <Ellipsis size={16} />
        </button>
        <h1 className="truncate text-[13.5px] font-medium text-gray-900">{title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-gray-800 transition-colors hover:bg-white/[0.055] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/40"
        >
          <Share2 size={14} />
          Share
        </button>
        <button
          type="button"
          aria-label={showArtifactPanel ? "Artifact panel open" : "Open artifact panel"}
          className="grid size-8 place-items-center rounded-lg text-gray-800 transition-colors hover:bg-white/[0.055] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/40"
        >
          <PanelRightOpen size={15} />
        </button>
      </div>
    </header>
  );
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="ml-auto w-fit max-w-2xl rounded-2xl border border-gray-200 bg-gray-50/75 px-4 py-3 text-sm leading-5 text-gray-950">
      {children}
    </div>
  );
}

function AssistantTurn({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <div className="space-y-3">
      <RunAccordion title="Searched multiple sources" defaultOpen>
        <div className="ml-[37px] space-y-3">
          <ThoughtAccordion>
            I should research the company, technical direction, recent funding, roles, and the
            user&apos;s profile before producing the brief.
          </ThoughtAccordion>

          <SearchAccordion
            query="Sycamore Labs company"
            resultsFound={10}
            results={COMPANY_RESULTS}
          />
          <SearchAccordion
            query="Sycamore Labs tech stack engineering"
            resultsFound={10}
            results={TECH_RESULTS}
          />

          <ToolStatus>Processed profile URL.</ToolStatus>

          <ThoughtAccordion>
            I have the company overview; now I need open roles and founder context to make the
            questions sharper.
          </ThoughtAccordion>

          <SearchAccordion
            query="Sycamore Labs careers hiring"
            resultsFound={10}
            results={ROLE_RESULTS}
          />
          <ToolStatus icon="user-search">People search completed successfully.</ToolStatus>
        </div>
      </RunAccordion>

      <ThoughtAccordion duration="34s" className="max-w-5xl">
        The company appears to be building trust and governance infrastructure for enterprise AI
        agents. The useful answer should connect that product thesis to reliability, memory,
        orchestration, and production ownership.
      </ThoughtAccordion>

      <AssistantProse />
      <ResponseActions />
      <RelatedSuggestions onSelect={onPrompt} />
    </div>
  );
}

function RunAccordion({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Disclosure title={title} defaultOpen={defaultOpen} triggerClassName="w-full text-gray-950">
      <div className="pt-1">{children}</div>
    </Disclosure>
  );
}

function ThoughtAccordion({
  children,
  duration = "2s",
  className,
}: {
  children: ReactNode;
  duration?: string;
  className?: string;
}) {
  return (
    <Disclosure
      title={`Thought for ${duration}`}
      triggerClassName={cn("text-gray-700", className)}
      contentClassName="text-gray-700"
    >
      <div className="max-w-[880px] pt-1 text-sm leading-[21px] text-gray-700">{children}</div>
    </Disclosure>
  );
}

function SearchAccordion({
  query,
  resultsFound,
  results,
}: {
  query: string;
  resultsFound: number;
  results: SearchResult[];
}) {
  return (
    <AccordionPrimitive.Root type="single" collapsible defaultValue="results">
      <AccordionPrimitive.Item value="results">
        <AccordionPrimitive.Header asChild>
          <h3>
            <AccordionPrimitive.Trigger
              className={cn(
                "group/search flex min-h-5 w-full max-w-2xl items-center gap-1 text-left text-sm font-medium leading-5 text-gray-950 outline-none",
                "focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-purple-600/35",
              )}
            >
              <span className="min-w-0 truncate font-normal text-gray-900">{query}</span>
              <ChevronRight
                size={16}
                aria-hidden
                className="shrink-0 text-gray-700 transition-transform group-data-[state=open]/search:rotate-90"
              />
              <span className="ml-auto shrink-0 pl-4 font-normal text-gray-700">
                {resultsFound} results found
              </span>
            </AccordionPrimitive.Trigger>
          </h3>
        </AccordionPrimitive.Header>

        <AccordionPrimitive.Content className="mt-1.5 max-h-[130px] max-w-2xl overflow-y-auto rounded-lg border border-gray-200 p-1 scrollbar">
          {results.map((result) => (
            <a
              key={`${result.domain}-${result.title}`}
              href={result.href}
              className="flex min-h-7 items-center justify-between gap-4 rounded p-1.5 text-gray-950 outline-none transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-purple-600/40"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 text-gray-900">
                <img
                  src={faviconFor(result.domain)}
                  alt=""
                  className="size-3 shrink-0 rounded-sm"
                  loading="lazy"
                />
                <span className="truncate">{result.title}</span>
              </span>
              <span className="shrink-0 text-[13px] font-light leading-4 text-gray-700">
                {result.domain}
              </span>
            </a>
          ))}
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}

function Disclosure({
  title,
  defaultOpen = false,
  children,
  triggerClassName,
  contentClassName,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      defaultValue={defaultOpen ? "content" : undefined}
    >
      <AccordionPrimitive.Item value="content">
        <AccordionPrimitive.Header asChild>
          <h3>
            <AccordionPrimitive.Trigger
              className={cn(
                "group/disclosure flex min-h-5 items-center gap-1 text-left text-sm font-medium leading-5 outline-none transition-colors",
                "focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-purple-600/35",
                triggerClassName,
              )}
            >
              <ChevronRight
                size={16}
                aria-hidden
                className="shrink-0 text-gray-700 transition-transform group-data-[state=open]/disclosure:rotate-90"
              />
              {typeof title === "string" ? <span className="truncate">{title}</span> : title}
            </AccordionPrimitive.Trigger>
          </h3>
        </AccordionPrimitive.Header>
        <AccordionPrimitive.Content className={cn("overflow-hidden text-sm", contentClassName)}>
          {children}
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}

function ToolStatus({
  children,
  icon = "processed",
}: {
  children: ReactNode;
  icon?: "processed" | "user-search";
}) {
  return (
    <div className="flex items-center gap-2 text-sm leading-5 text-gray-900">
      {icon === "user-search" ? (
        <svg
          className="size-[18px] shrink-0"
          viewBox="0 0 24 24"
          role="img"
          aria-label="user-search"
        >
          <title>user-search</title>
          <path
            d="M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M3.5 20a6.5 6.5 0 0 1 9.8-5.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="m17.8 17.8 3.2 3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="16" cy="16" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ) : (
        <Bot size={18} aria-hidden className="shrink-0 text-gray-800" />
      )}
      <span>{children}</span>
    </div>
  );
}

function AssistantProse({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="max-w-[900px] text-sm leading-[22px] text-gray-900">
        <p>
          Short final answers still render as assistant prose rather than a bubble, followed by the
          same copy and rating controls.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[900px] space-y-3 text-sm leading-[22px] text-gray-900">
      <section className="space-y-2">
        <h2 className="text-[22px] font-semibold leading-7 text-gray-950">Interview Brief</h2>
        <h3 className="text-[17px] font-semibold leading-6 text-gray-950">The Company</h3>
        <p>
          The company is building an enterprise agent operating layer: infrastructure that lets
          organizations deploy, orchestrate, and govern AI agents safely. The founder profile and
          recent funding coverage point to a serious enterprise-platform bet{" "}
          <Citation domain="linkedin.com">Founder profile</Citation>{" "}
          <Citation domain="businesswire.com">seed round</Citation>.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-[17px] font-semibold leading-6 text-gray-950">Where You Fit</h3>
        <div
          role="table"
          aria-label="Profile fit comparison"
          className="grid max-w-[720px] grid-cols-2 overflow-hidden rounded-2xl border border-white/10 bg-[#1b1b1b]/50 text-[12.5px]"
        >
          <Cell header>Your experience</Cell>
          <Cell header>Company relevance</Cell>
          <Cell>RAG pipelines, agents, and workflows</Cell>
          <Cell>Core to orchestration and memory systems</Cell>
          <Cell>Reliability and production debugging</Cell>
          <Cell>Maps to trust, guardrails, and auditability</Cell>
          <Cell>Founding-engineer ownership</Cell>
          <Cell>Small team, broad surface area, high ambiguity</Cell>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-[17px] font-semibold leading-6 text-gray-950">Sharp Questions</h3>
        <p>
          Ask how they measure trust, where generated systems pass review, what memory architecture
          looks like across multiple agents, and what surface area the role would own in the first
          90 days.
        </p>
      </section>
    </div>
  );
}

function Cell({ children, header }: { children: ReactNode; header?: boolean }) {
  return (
    <div className="min-w-0 border-b border-r border-[#1d1d1d] px-3 py-2 text-gray-900">
      {header ? <strong className="text-gray-950">{children}</strong> : children}
    </div>
  );
}

function Citation({ domain, children }: { domain: string; children: ReactNode }) {
  return (
    <a
      href={`https://${domain}`}
      className="inline-flex items-center gap-1 align-middle text-purple-600 outline-none transition-colors hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-purple-600/35"
    >
      <span className="relative inline-grid size-4 place-items-center overflow-hidden rounded">
        <img
          src={faviconFor(domain)}
          alt="Web Search"
          className="size-full object-cover"
          loading="lazy"
        />
      </span>
      <span>{children}</span>
    </a>
  );
}

function ResponseActions() {
  return (
    <div className="flex items-center gap-1.5" aria-label="Response actions">
      <button type="button" aria-label="Copy response" className={reactionClassName}>
        <Copy size={15} />
      </button>
      <button type="button" aria-label="Good response" className={reactionClassName}>
        <ThumbsUp size={15} />
      </button>
      <button type="button" aria-label="Bad response" className={reactionClassName}>
        <ThumbsUp size={15} className="rotate-180" />
      </button>
    </div>
  );
}

const reactionClassName =
  "grid size-5 place-items-center rounded-md text-gray-800 transition-colors hover:bg-white/[0.055] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35";

function RelatedSuggestions({ onSelect }: { onSelect: (prompt: string) => void }) {
  const suggestions = [
    "Turn this into a concise interview checklist",
    "Draft a 90-day ownership plan",
    "Compare this role against my current priorities",
  ];

  return (
    <div className="max-w-[720px] pt-1">
      <p className="mb-1 text-sm text-gray-700">Related</p>
      <div className="divide-y divide-gray-50">
        {suggestions.map((suggestion, index) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSelect(suggestion)}
            className="group/suggestion flex w-full items-center justify-between gap-4 py-3 pr-3 text-left outline-none transition-colors hover:bg-[#151515] focus-visible:bg-[#151515] focus-visible:ring-2 focus-visible:ring-purple-600/35"
          >
            <span className="min-w-0 truncate text-sm text-gray-900 transition-colors group-hover/suggestion:text-gray-950">
              {suggestion}
            </span>
            <span className="frost-border grid size-5 shrink-0 place-items-center rounded-md text-xs font-medium text-gray-800">
              {index + 1}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadComposer({ onSubmit }: { onSubmit: (prompt: string) => void }) {
  const [value, setValue] = useState("");
  const [autoMode, setAutoMode] = useState(true);
  const [model, setModel] = useState("alfred");
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
      }),
      Placeholder.configure({
        placeholder: "Send a message to continue the conversation",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        "aria-label": "Message",
        class:
          "tiptap ProseMirror tiptap-minimum-input composer-editor max-h-[240px] min-h-12 overflow-y-auto px-3 pb-2 pt-3 text-sm leading-5 text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35",
      },
    },
    onUpdate: ({ editor }) => setValue(editor.getText()),
  });

  const submit = () => {
    const prompt = editor?.getText().trim() ?? "";
    if (!prompt) return;
    onSubmit(prompt);
    editor?.commands.clearContent();
    setValue("");
    queueMicrotask(() => editor?.commands.focus());
  };

  const hasContent = value.trim().length > 0;
  const contextItems: DimensionComposerMenuItem[] = [
    {
      label: "Mention a tool",
      description: "Reference integrations in the next reply",
      icon: <AtSign size={15} />,
      disabled: true,
    },
    {
      label: "Attach artifact",
      description: "Use the current briefing as context",
      icon: <FileText size={15} />,
      disabled: true,
    },
    {
      label: "Upload file",
      description: "Coming with artifact ingestion",
      icon: <FileUp size={15} />,
      disabled: true,
    },
    {
      label: "Connect tools",
      description: "Manage source access",
      icon: <Link2 size={15} />,
      href: "/integrations",
    },
  ];
  const overflowItems: DimensionComposerMenuItem[] = [
    {
      label: autoMode ? "Switch to manual review" : "Switch to auto mode",
      description: autoMode ? "Ask before durable changes" : "Let Alfred proceed locally",
      icon: <Settings2 size={15} />,
      onSelect: () => setAutoMode((mode) => !mode),
    },
    {
      label: "Thread settings",
      description: "Title, sharing, and run controls",
      icon: <Ellipsis size={15} />,
      disabled: true,
    },
  ];
  const modelOptions = CHAT_MODEL_OPTIONS.map((option) => ({
    ...option,
    selected: option.id === model,
  }));

  return (
    <DimensionComposerShell
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="absolute inset-x-3 bottom-4 mx-auto max-w-5xl rounded-2xl border border-white/[0.08] bg-[#101010]/90 p-1 shadow-pop backdrop-blur-xl"
      toolbar={
        <DimensionComposerToolbar
          startClassName="flex-1"
          start={
            <>
              <DimensionComposerContextMenu items={contextItems}>
                <Plus size={15} />
              </DimensionComposerContextMenu>
              <button
                type="button"
                aria-pressed={autoMode}
                onClick={() => setAutoMode((mode) => !mode)}
                className={cn(
                  "inline-flex h-8 min-w-[72px] items-center justify-center gap-1.5 rounded-[10px] px-3",
                  "text-[13px] text-white/86 backdrop-blur-sm transition-[background-color,filter]",
                  autoMode
                    ? "bg-[linear-gradient(180deg,#0f0f0f_0%,#1e1e1e_100%)]"
                    : "bg-white/[0.055] hover:bg-white/[0.075]",
                )}
              >
                Auto
                <span
                  aria-hidden
                  className={cn(
                    "size-2 rounded-full",
                    autoMode
                      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]"
                      : "bg-white/20",
                  )}
                />
              </button>
              <span className="ml-auto hidden text-xs text-white/45 sm:inline">
                {autoMode ? "Ready for review gates" : "Manual review mode"}
              </span>
            </>
          }
          end={
            <>
              <DimensionModelPicker
                value={CHAT_MODEL_OPTIONS.find((option) => option.id === model)?.label ?? "Alfred"}
                options={modelOptions}
                onSelect={setModel}
              />
              <DimensionComposerOverflowMenu items={overflowItems} />
              <DimensionComposerIconButton label="Dictate" disabled>
                <Mic size={15} />
              </DimensionComposerIconButton>
              <DimensionComposerSendButton disabled={!hasContent} />
            </>
          }
        />
      }
    >
      <div
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
    </DimensionComposerShell>
  );
}

function ArtifactPanel() {
  return (
    <aside className="hidden w-[420px] shrink-0 border-l border-white/[0.06] bg-[#101010] p-2 xl:block">
      <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0c0c0c]">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
          <FileText size={16} className="text-gray-800" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-gray-950">
            Sycamore Labs briefing
          </h2>
          <IconMini label="Share">
            <Share2 size={14} />
          </IconMini>
          <IconMini label="Download">
            <Download size={14} />
          </IconMini>
          <IconMini label="Open fullscreen">
            <Maximize2 size={14} />
          </IconMini>
          <IconMini label="Close">
            <X size={14} />
          </IconMini>
        </header>
        <div className="minimal-scrollbar flex-1 overflow-y-auto p-4">
          <div className="space-y-3">
            {SYCAMORE_BRIEF_PAGES.map((page, index) => (
              <section
                key={page.title}
                aria-label={`Artifact page ${index + 1}`}
                className="space-y-2"
              >
                <div className="flex items-center justify-between text-xs text-gray-700">
                  <span>{index === 0 ? "Cover Page" : page.title}</span>
                  <span>
                    {index + 1} / {SYCAMORE_BRIEF_PAGES.length}
                  </span>
                </div>
                {page.html ? (
                  <ArtifactPageFrame
                    html={page.html}
                    title={`Sycamore PDF page ${index + 1}`}
                    className="rounded-xl ring-1 ring-white/[0.08]"
                  />
                ) : null}
              </section>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function IconMini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="grid size-7 place-items-center rounded-lg text-gray-700 transition-colors hover:bg-white/[0.055] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35"
    >
      {children}
    </button>
  );
}

function faviconFor(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}
