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
  Loader2,
  Maximize2,
  Mic,
  PanelRightOpen,
  Plus,
  Search,
  Settings2,
  Share2,
  ThumbsUp,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
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

export type ChatPreviewState =
  | "completed"
  | "all-expanded"
  | "streaming"
  | "active-tool"
  | "rich-content";
export type ArtifactPreviewState = "completed" | "generating" | "empty";

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
  previewState = "completed",
  artifactState = "completed",
}: {
  showArtifactPanel?: boolean;
  previewState?: ChatPreviewState;
  artifactState?: ArtifactPreviewState;
}) {
  const [localTurns, setLocalTurns] = useState<LocalPreviewTurn[]>([]);
  const allExpanded = previewState === "all-expanded";

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

                {previewState === "streaming" || previewState === "active-tool" ? (
                  <StreamingAssistantTurn phase={previewState} />
                ) : (
                  <AssistantTurn
                    allExpanded={allExpanded}
                    richContent={previewState === "rich-content"}
                    onPrompt={addLocalTurn}
                  />
                )}

                {previewState === "streaming" || previewState === "active-tool" ? null : (
                  <>
                    <UserBubble>No need for the PDF yet. Give me one more quick lookup.</UserBubble>

                    <div className="space-y-3">
                      <RunAccordion title="Gathered information" defaultOpen={allExpanded}>
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
                            defaultOpen={allExpanded}
                          />
                        </div>
                      </RunAccordion>
                      <AssistantProse compact />
                      <ResponseActions />
                    </div>
                  </>
                )}

                {localTurns.map((turn) => (
                  <LocalPreviewTurn key={turn.id} turn={turn} />
                ))}
              </div>
            </div>
          </div>

          <ThreadComposer onSubmit={addLocalTurn} />
        </section>

        {showArtifactPanel ? <ArtifactPanel state={artifactState} /> : null}
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

function AssistantTurn({
  allExpanded = false,
  richContent = false,
  onPrompt,
}: {
  allExpanded?: boolean;
  richContent?: boolean;
  onPrompt: (prompt: string) => void;
}) {
  return (
    <div className="space-y-3">
      <RunAccordion title="Searched multiple sources" defaultOpen>
        <div className="ml-[37px] space-y-3">
          <ThoughtAccordion defaultOpen={allExpanded}>
            I should research the company, technical direction, recent funding, roles, and the
            user&apos;s profile before producing the brief.
          </ThoughtAccordion>

          <SearchAccordion
            query="Sycamore Labs company"
            resultsFound={10}
            results={COMPANY_RESULTS}
            defaultOpen={allExpanded}
          />
          <SearchAccordion
            query="Sycamore Labs tech stack engineering"
            resultsFound={10}
            results={TECH_RESULTS}
            defaultOpen={allExpanded}
          />

          <ToolStatus>Processed profile URL.</ToolStatus>

          <ThoughtAccordion defaultOpen={allExpanded}>
            I have the company overview; now I need open roles and founder context to make the
            questions sharper.
          </ThoughtAccordion>

          <SearchAccordion
            query="Sycamore Labs careers hiring"
            resultsFound={10}
            results={ROLE_RESULTS}
            defaultOpen={allExpanded}
          />
          <ToolStatus icon="user-search">People search completed successfully.</ToolStatus>
        </div>
      </RunAccordion>

      <ThoughtAccordion duration="34s" className="max-w-5xl" defaultOpen={allExpanded}>
        The company appears to be building trust and governance infrastructure for enterprise AI
        agents. The useful answer should connect that product thesis to reliability, memory,
        orchestration, and production ownership.
      </ThoughtAccordion>

      {richContent ? <RichAssistantProse /> : <AssistantProse />}
      <ResponseActions />
      <RelatedSuggestions onSelect={onPrompt} />
    </div>
  );
}

function StreamingAssistantTurn({ phase }: { phase: "streaming" | "active-tool" }) {
  const isActiveTool = phase === "active-tool";

  return (
    <div className="space-y-3">
      <RunAccordion title={isActiveTool ? "Searching sources" : "Thinking"} defaultOpen>
        <div className="ml-[37px] space-y-3">
          <ActiveThoughtRow>
            I&apos;m checking company updates, engineering signals, and role context before turning
            this into an interview prep brief.
          </ActiveThoughtRow>

          {isActiveTool ? (
            <>
              <ActiveToolRow
                title="Searching web"
                description="Sycamore Labs recent funding engineering direction"
              />
              <StreamingSearchPreview />
            </>
          ) : (
            <PendingToolRow
              title="Preparing web search"
              description="Choosing the highest-signal company and role queries"
            />
          )}
        </div>
      </RunAccordion>

      <div className="max-w-[900px] space-y-2 text-sm leading-[22px] text-gray-900">
        <p>
          I&apos;m building the brief around three angles: company thesis, technical direction, and
          questions that expose how much ownership this role actually carries
          <span className="ml-1 inline-block h-4 w-[7px] translate-y-[2px] animate-pulse rounded-sm bg-gray-800" />
        </p>
        {isActiveTool ? (
          <p className="text-gray-700">
            Search results are still resolving, so I&apos;m holding the final recommendations until
            source context is stable.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ActiveThoughtRow({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[880px] rounded-xl border border-gray-100 bg-gray-50/55 px-3 py-2 text-sm leading-[21px] text-gray-800">
      <div className="mb-1 flex items-center gap-2 text-[13px] font-medium text-gray-950">
        <Loader2 size={14} className="animate-spin text-purple-600" />
        Thought for 4s
      </div>
      {children}
    </div>
  );
}

function ActiveToolRow({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex max-w-2xl items-center gap-2 rounded-xl border border-purple-500/25 bg-purple-500/5 px-3 py-2 text-sm leading-5 text-white/90">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-purple-500/12 text-purple-600">
        <Search size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-gray-950">{title}</span>
        <span className="block truncate text-[12.5px] text-gray-700">{description}</span>
      </span>
      <Loader2 size={15} className="shrink-0 animate-spin text-purple-600" />
    </div>
  );
}

function PendingToolRow({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex max-w-2xl items-center gap-2 text-sm leading-5 text-gray-800">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-gray-50 text-gray-700">
        <Search size={16} />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-gray-950">{title}</span>
        <span className="block truncate text-[12.5px] text-gray-700">{description}</span>
      </span>
    </div>
  );
}

function StreamingSearchPreview() {
  return (
    <div className="max-w-2xl overflow-hidden rounded-lg border border-gray-200 p-1">
      {["Company research memo", "Founder interview notes", "Open engineering roles"].map(
        (label, index) => (
          <div
            key={label}
            className="flex min-h-7 items-center justify-between gap-4 rounded p-1.5 text-[13px] leading-4"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-gray-900">
              <span className="size-3 shrink-0 rounded-sm bg-gray-100" />
              <span className="truncate">{label}</span>
            </span>
            <span
              className={cn("h-3 shrink-0 rounded bg-gray-100", index === 0 ? "w-24" : "w-20")}
            />
          </div>
        ),
      )}
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
  defaultOpen,
}: {
  children: ReactNode;
  duration?: string;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <Disclosure
      title={`Thought for ${duration}`}
      defaultOpen={defaultOpen}
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
  defaultOpen = true,
}: {
  query: string;
  resultsFound: number;
  results: SearchResult[];
  defaultOpen?: boolean;
}) {
  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      defaultValue={defaultOpen ? "results" : undefined}
    >
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

function RichAssistantProse() {
  return (
    <div className="max-w-[900px] space-y-4 text-sm leading-[22px] text-gray-900">
      <section className="space-y-2">
        <h2 className="text-[22px] font-semibold leading-7 text-gray-950">Interview Brief</h2>
        <p>
          The strongest signal is that Sycamore is treating AI agents as enterprise infrastructure:
          orchestration, trust boundaries, review loops, and memory become product primitives rather
          than one-off workflow glue.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-[17px] font-semibold leading-6 text-gray-950">Prep Checklist</h3>
        <ul className="list-inside list-disc space-y-1 text-gray-900">
          <li>Connect their product thesis to reliability and auditability.</li>
          <li>Ask where agent actions require human review versus automatic execution.</li>
          <li>Bring one concrete example of production debugging under ambiguity.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-[17px] font-semibold leading-6 text-gray-950">Role Fit Matrix</h3>
        <div
          role="table"
          aria-label="Role fit matrix"
          className="grid max-w-[760px] grid-cols-[1fr_1fr_0.7fr] overflow-hidden rounded-2xl border border-gray-200 bg-gray-50/55 text-[12.5px]"
        >
          <Cell header>Signal</Cell>
          <Cell header>Why it matters</Cell>
          <Cell header>Prep angle</Cell>
          <Cell>Agent orchestration</Cell>
          <Cell>Core technical surface for enterprise adoption</Cell>
          <Cell>Systems design</Cell>
          <Cell>Human review gates</Cell>
          <Cell>Determines trust and liability boundaries</Cell>
          <Cell>Product judgment</Cell>
          <Cell>Memory and retrieval</Cell>
          <Cell>Turns one-off answers into durable workflows</Cell>
          <Cell>Architecture</Cell>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-[17px] font-semibold leading-6 text-gray-950">
          Code-Adjacent Question
        </h3>
        <p>Ask how they model tool execution policy. A good follow-up could sound like:</p>
        <pre className="max-w-[760px] overflow-x-auto rounded-2xl border border-gray-200 bg-[#111] p-3 text-[12.5px] leading-5 text-white/82">
          <code>{`type ToolPolicy = {
  requiresReview: boolean;
  allowedScopes: string[];
  auditTrail: "none" | "summary" | "full";
};`}</code>
        </pre>
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
  // Latest submit closure routed through a ref so TipTap's once-registered
  // handleKeyDown always sees the current state.
  const submitRef = useRef<() => void>(() => undefined);

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
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
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
  submitRef.current = submit;

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
      <EditorContent editor={editor} />
    </DimensionComposerShell>
  );
}

function ArtifactPanel({ state }: { state: ArtifactPreviewState }) {
  const generatedPages =
    state === "generating" ? SYCAMORE_BRIEF_PAGES.slice(0, 3) : SYCAMORE_BRIEF_PAGES;
  const [selectedPage, setSelectedPage] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const selected = generatedPages[selectedPage] ?? generatedPages[0];
  const isEmpty = state === "empty";
  const isGenerating = state === "generating";

  return (
    <aside className="hidden w-[420px] shrink-0 border-l border-white/[0.06] bg-[#101010] p-2 xl:block">
      <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0c0c0c]">
        <header className="flex h-[65px] shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-white/[0.045] text-gray-800">
            <FileText size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-gray-950">
              Sycamore Labs - Key People & Role Preparation Guide
            </h2>
            <p className="mt-0.5 truncate text-[12px] text-gray-700">
              PDF Document ·{" "}
              {isEmpty
                ? "No pages yet"
                : `${generatedPages.length} of ${SYCAMORE_BRIEF_PAGES.length} pages`}
            </p>
          </div>
          <IconMini label="Share">
            <Share2 size={14} />
          </IconMini>
          <IconMini label="Download">
            <Download size={14} />
          </IconMini>
          <IconMini
            label={fullscreen ? "Exit fullscreen" : "Open fullscreen"}
            onClick={() => setFullscreen((open) => !open)}
          >
            <Maximize2 size={14} />
          </IconMini>
          <IconMini label="Close">
            <X size={14} />
          </IconMini>
        </header>

        <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.045] px-3">
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-gray-700">
            {isGenerating ? (
              <>
                <Loader2 size={13} className="animate-spin text-purple-500" />
                <span>Generating PDF pages</span>
              </>
            ) : isEmpty ? (
              <span>Waiting for page output</span>
            ) : (
              <span>
                Viewing page {selectedPage + 1} of {SYCAMORE_BRIEF_PAGES.length}
              </span>
            )}
          </div>
          {!isEmpty ? (
            <span className="rounded-full bg-white/[0.045] px-2 py-0.5 text-[11px] text-gray-800">
              {selected?.title ?? "Page"}
            </span>
          ) : null}
        </div>

        {isEmpty ? (
          <ArtifactEmptyState />
        ) : (
          <>
            <div className="shrink-0 border-b border-white/[0.045] px-3 py-2">
              <div className="minimal-scrollbar flex gap-2 overflow-x-auto pb-1">
                {SYCAMORE_BRIEF_PAGES.map((page, index) => {
                  const ready = index < generatedPages.length;
                  const active = index === selectedPage;
                  return (
                    <button
                      key={page.title}
                      type="button"
                      disabled={!ready}
                      onClick={() => setSelectedPage(index)}
                      className={cn(
                        "group/thumb w-[82px] shrink-0 rounded-xl border p-1 text-left transition-colors",
                        active
                          ? "border-purple-500/55 bg-purple-500/10"
                          : "border-white/[0.075] bg-white/[0.025] hover:bg-white/[0.05]",
                        !ready && "cursor-not-allowed opacity-45",
                      )}
                    >
                      <div className="overflow-hidden rounded-lg bg-white">
                        {ready && page.html ? (
                          <ArtifactPageFrame
                            html={page.html}
                            title={`${page.title} thumbnail`}
                            className="rounded-lg shadow-none"
                          />
                        ) : (
                          <div className="grid aspect-[8.5/11] place-items-center bg-gray-100">
                            <Loader2 size={14} className="animate-spin text-gray-500" />
                          </div>
                        )}
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-700">
                        <span>Page {index + 1}</span>
                        {active ? <span className="text-purple-300">Viewing</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="minimal-scrollbar flex-1 overflow-y-auto p-4">
              <div className={cn("space-y-3", fullscreen && "mx-auto max-w-[520px]")}>
                {generatedPages.map((page, index) => (
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

                {isGenerating ? (
                  <section aria-label="Artifact page generating" className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-gray-700">
                      <span>Creating page…</span>
                      <span>
                        {generatedPages.length + 1} / {SYCAMORE_BRIEF_PAGES.length}
                      </span>
                    </div>
                    <div className="grid aspect-[8.5/11] place-items-center rounded-xl border border-white/[0.08] bg-[#111] text-center">
                      <div>
                        <Loader2 size={18} className="mx-auto animate-spin text-purple-400" />
                        <p className="mt-3 text-sm font-medium text-gray-950">
                          Creating Interview Strategy page
                        </p>
                        <p className="mt-1 text-[12px] text-gray-700">
                          Page content will appear here as it resolves.
                        </p>
                      </div>
                    </div>
                  </section>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function ArtifactEmptyState() {
  return (
    <div className="grid flex-1 place-items-center px-8 text-center">
      <div>
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-white/[0.045] text-gray-700">
          <FileText size={22} />
        </span>
        <h3 className="mt-4 text-base font-medium text-gray-950">No Pages Yet</h3>
        <p className="mt-1 text-sm leading-5 text-gray-700">
          Pages appear here as they&apos;re generated.
        </p>
      </div>
    </div>
  );
}

function IconMini({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg text-gray-700 transition-colors hover:bg-white/[0.055] hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35"
    >
      {children}
    </button>
  );
}

function faviconFor(domain: string) {
  // DuckDuckGo (cookieless, no 404s) over Google's s2/favicons — see the note
  // on `faviconUrl` in routes/-preview-chat/inbox-feed.tsx.
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}
