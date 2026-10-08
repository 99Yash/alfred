import Mention from "@tiptap/extension-mention";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type JSONContent,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { useMentionConnections } from "./mention-connection";
import { filterMentionOptions, getMentionOption, type MentionOption } from "./mention-options";

/** Like Tiptap's `editor.isEmpty`, for the initial doc before the editor mounts. */
function isInitialContentEmpty(initialJSON?: JSONContent): boolean {
  if (!initialJSON) return true;
  const content = initialJSON.content;

  if (!content || content.length === 0) return true;

  if (content.length === 1) {
    const only = content[0];

    if (only?.type === "paragraph" && (!only.content || only.content.length === 0)) return true;
  }

  return false;
}

/** Touch or pen input: Enter inserts a newline there, since Shift+Enter is unreliable. */
function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);
}

export interface SuggestionRenderState {
  query: string;
  /** Insert the option as a mention node and close the popup. */
  command: (item: MentionOption) => void;
  /** Remove the `@<query>` range, to dismiss on Esc or outside click. */
  dismiss: () => void;
}

export interface TiptapComposerHandle {
  focusEnd: () => void;
  /** Insert a character at the caret, for type-anywhere. */
  insertText: (text: string) => void;
  /** Insert `@`, with a leading space if needed, to open the palette. */
  insertAtTrigger: () => void;
  clear: () => void;
  /** No text and no mentions. */
  isEmpty: () => boolean;
}

interface TiptapComposerProps {
  ref?: Ref<TiptapComposerHandle> | undefined;
  initialJSON?: JSONContent | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  onChange: (text: string, json: JSONContent, isEmpty: boolean) => void;
  onSubmit: () => void;
  /** Suggestion lifecycle. The parent renders the palette. */
  onSuggestionChange: (state: SuggestionRenderState | null) => void;
  /** Key handler while a suggestion is active. Return `true` to consume the key. */
  suggestionKeyDownRef: React.MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
  /** Dimmed suggested prompt in the empty editor. Tab accepts; Escape dismisses. */
  ghostText?: string | undefined;
  onGhostAccept?: (() => void) | undefined;
  onGhostDismiss?: (() => void) | undefined;
}

/**
 * Tiptap composer. The suggestion plugin reports through `onSuggestionChange`; the parent renders the palette.
 * Key handling goes through a ref, so the editor is not recreated each render.
 */
export function TiptapComposer({
  ref,
  initialJSON,
  placeholder,
  className,
  disabled = false,
  onChange,
  onSubmit,
  onSuggestionChange,
  suggestionKeyDownRef,
  ghostText,
  onGhostAccept,
  onGhostDismiss,
}: TiptapComposerProps) {
  // Refs keep Tiptap's closures stable. An effect syncs them; a render-phase write can leak from a discarded render.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onSuggestionChangeRef = useRef(onSuggestionChange);
  const disabledRef = useRef(disabled);
  const ghostTextRef = useRef(ghostText);
  const onGhostAcceptRef = useRef(onGhostAccept);
  const onGhostDismissRef = useRef(onGhostDismiss);
  // Skip Enter-submit while picking a mention.
  const suggestionOpenRef = useRef(false);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
    onSuggestionChangeRef.current = onSuggestionChange;
    disabledRef.current = disabled;
    ghostTextRef.current = ghostText;
    onGhostAcceptRef.current = onGhostAccept;
    onGhostDismissRef.current = onGhostDismiss;

    if (disabled) suggestionOpenRef.current = false;
  }, [onChange, onSubmit, onSuggestionChange, disabled, ghostText, onGhostAccept, onGhostDismiss]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      Mention.extend({
        addNodeView() {
          return ReactNodeViewRenderer(MentionChipNodeView);
        },
      }).configure({
        // So `editor.getText()` keeps the mention.
        renderText({ node }) {
          const label = node.attrs.label ?? node.attrs.id ?? "";

          return `@${label}`;
        },
        // Backspace before a chip deletes all of it, not just to a stray `@`.
        deleteTriggerWithBackspace: true,
        HTMLAttributes: {
          class: "tiptap-mention-chip",
        },
        suggestion: {
          char: "@",
          allowSpaces: false,
          items: ({ query }) => Array.from(filterMentionOptions(query)),
          render: () => ({
            onStart: (props) => {
              suggestionOpenRef.current = true;
              onSuggestionChangeRef.current({
                query: props.query,
                command: (item) => props.command({ id: item.value, label: item.label }),
                dismiss: () => {
                  props.editor.chain().focus().deleteRange(props.range).run();
                },
              });
            },
            onUpdate: (props) => {
              onSuggestionChangeRef.current({
                query: props.query,
                command: (item) => props.command({ id: item.value, label: item.label }),
                dismiss: () => {
                  props.editor.chain().focus().deleteRange(props.range).run();
                },
              });
            },
            onExit: () => {
              suggestionOpenRef.current = false;
              onSuggestionChangeRef.current(null);
            },
            onKeyDown: ({ event }) => suggestionKeyDownRef.current?.(event) ?? false,
          }),
        },
      }),
    ],
    ...(initialJSON ? { content: initialJSON } : {}),
    autofocus: "end",
    editable: !disabled,
    editorProps: {
      attributes: {
        // `aria-label` is prohibited on a generic element; `role="textbox"` makes it valid.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        class: cn(
          "tiptap tiptap-minimum-input composer-editor",
          "wrap-break-word whitespace-pre-wrap outline-none",
          "max-h-64 min-h-[64px] overflow-y-auto px-3 pt-2 pb-1.5",
          // Fade content scrolled under the padding instead of a hard clip.
          "[mask-image:linear-gradient(to_bottom,transparent,#000_10px,#000_calc(100%_-_8px),transparent)]",
          "[-webkit-mask-image:linear-gradient(to_bottom,transparent,#000_10px,#000_calc(100%_-_8px),transparent)]",
          "text-[15px] leading-7 font-medium tracking-tight text-app-fg-4",
          "caret-app-purple-3",
          className ?? "",
        ),
      },
      handleKeyDown: (view, event) => {
        if (disabledRef.current) return true;

        // The suggestion plugin handles its own keys.
        if (suggestionOpenRef.current) return false;

        if (event.key === "Enter" && !event.shiftKey) {
          // Touch: Enter inserts a newline, as in mobile chat apps. Send uses the button.
          if (isCoarsePointer()) return false;
          event.preventDefault();
          onSubmitRef.current();

          return true;
        }

        // Ghost text, only while empty. `editor` is set before any keydown fires.
        const ghostActive = Boolean(ghostTextRef.current) && (editor?.isEmpty ?? false);

        if (ghostActive && event.key === "Tab") {
          event.preventDefault();
          const ghost = ghostTextRef.current;

          if (ghost) {
            editor?.chain().focus("end").insertContent(ghost).run();
            onGhostAcceptRef.current?.();
          }

          return true;
        }

        if (event.key === "Escape") {
          if (ghostActive) {
            onGhostDismissRef.current?.();

            return true;
          }

          // Blur so global shortcuts (⌘K) get the keys.
          if (view.dom instanceof HTMLElement) view.dom.blur();

          return false;
        }

        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const empty = editor.isEmpty;
      onChangeRef.current(editor.getText(), editor.getJSON(), empty);
    },
  });

  const isEmpty = editor?.isEmpty ?? isInitialContentEmpty(initialJSON);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useImperativeHandle(
    ref,
    () => ({
      focusEnd: () => editor?.commands.focus("end"),
      insertText: (text) => {
        if (!editor || disabledRef.current) return;
        editor.chain().focus("end").insertContent(text).run();
      },
      insertAtTrigger: () => {
        if (!editor || disabledRef.current) return;
        // Suggestion's `allowedPrefixes` defaults to [' '], so the `@` needs a space or doc start before it.
        const { from } = editor.state.selection;
        const prev = from > 1 ? editor.state.doc.textBetween(from - 1, from, "\n", "\n") : "";
        const needsSpace = prev !== "" && prev !== " " && prev !== "\n";
        editor
          .chain()
          .focus()
          .insertContent(needsSpace ? " @" : "@")
          .run();
      },
      clear: () => editor?.commands.clearContent(true),
      isEmpty: () => editor?.isEmpty ?? true,
    }),
    [editor],
  );

  const ghostVisible = Boolean(ghostText) && isEmpty && !disabled;

  return (
    <div className="relative">
      <EditorContent editor={editor} />
      {ghostVisible ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-3 top-2",
            "flex items-center gap-1.5",
            "text-[15px] leading-7 font-medium tracking-tight text-app-fg-2",
            "animate-chat-in",
          )}
        >
          <span className="min-w-0 truncate">{ghostText}</span>
          <kbd
            className={cn(
              "inline-flex h-[18px] shrink-0 items-center justify-center rounded-md px-1.5",
              "font-sans text-[10.5px] leading-none font-medium",
              "bg-app-bg-a2 text-app-fg-2",
            )}
          >
            Tab
          </kbd>
        </span>
      ) : null}
      {placeholder ? (
        <span
          aria-hidden
          data-visible={isEmpty && !ghostVisible}
          className={cn(
            // Matches the editor's first-line position (px-3 pt-2).
            "pointer-events-none absolute top-2 left-3",
            "text-[15px] leading-7 font-medium tracking-tight text-app-fg-2",
            "transition-[opacity,filter,transform] duration-300 ease-out",
            "data-[visible=true]:blur-0 data-[visible=true]:translate-x-0 data-[visible=true]:opacity-100",
            "data-[visible=false]:translate-x-7 data-[visible=false]:opacity-0 data-[visible=false]:blur-sm",
          )}
        >
          {placeholder}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Mention chip: an inline-block pill with glyph and label.
 * A chip can outlive its connection (disconnect after insert); then it dims and gets a tooltip.
 */
function MentionChipNodeView({ node }: NodeViewProps) {
  const id: string = node.attrs.id ?? "";
  const label: string = node.attrs.label ?? id;
  const option = getMentionOption(id);
  const Icon = option?.icon;
  const connections = useMentionConnections();
  const disconnected = connections(id) === "connectable";

  return (
    <NodeViewWrapper
      as="span"
      data-mention={id}
      title={disconnected ? `@${label} is not connected` : undefined}
      className={cn(
        "inline-flex items-center gap-[3px] align-baseline",
        "mx-px rounded-[6px] px-1.5 py-px",
        "bg-app-bg-a2 font-medium text-app-fg-4",
        "ring-1 ring-app-fg-a1/20 ring-inset",
        "text-[0.92em] leading-[1.35]",
        "cursor-default select-none",
      )}
    >
      <span aria-hidden className="inline-flex shrink-0 items-center">
        {option?.brand ? (
          <IntegrationGlyph brand={option.brand} size={11} />
        ) : Icon ? (
          <Icon
            size={11}
            strokeWidth={2}
            className={cn("text-app-fg-3", disconnected && "opacity-50")}
          />
        ) : null}
      </span>
      <span className={cn(disconnected && "opacity-60")}>@{label}</span>
      {disconnected ? <span className="sr-only">Not connected</span> : null}
    </NodeViewWrapper>
  );
}
