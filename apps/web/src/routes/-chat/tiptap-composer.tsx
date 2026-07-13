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
import { filterMentionOptions, getMentionOption, type MentionOption } from "./mention-options";

/**
 * Approximates Tiptap's `editor.isEmpty` against a serialized initial doc so
 * we can seed local empty state without waiting for the editor to mount. The
 * empty-paragraph special case mirrors Tiptap's default representation of an
 * empty document.
 */
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

export interface SuggestionRenderState {
  query: string;
  /** Commits the picked option as a mention node and closes the popup. */
  command: (item: MentionOption) => void;
  /** Removes the `@<query>` trigger range — used to dismiss on Esc / outside click. */
  dismiss: () => void;
}

export interface TiptapComposerHandle {
  /** Focus the editor at the end of content. */
  focusEnd: () => void;
  /** Insert a printable character at the caret. Used by type-anywhere autofocus. */
  insertText: (text: string) => void;
  /** Insert `@` (with a leading space if needed) to open the mention palette. */
  insertAtTrigger: () => void;
  /** Wipe content. */
  clear: () => void;
  /** True when the document is effectively empty (no text, no mentions). */
  isEmpty: () => boolean;
}

interface TiptapComposerProps {
  ref?: Ref<TiptapComposerHandle>;
  initialJSON?: JSONContent;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  onChange: (text: string, json: JSONContent, isEmpty: boolean) => void;
  onSubmit: () => void;
  /** Suggestion lifecycle (start / update / exit). The parent renders its own palette UI. */
  onSuggestionChange: (state: SuggestionRenderState | null) => void;
  /** Keyboard handler invoked while the suggestion is active. Return `true` to consume the key. */
  suggestionKeyDownRef: React.MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
  /**
   * Ghost text — a suggested next prompt rendered dimmed inside the empty
   * editor. Tab accepts it (fills the doc and fires `onGhostAccept`); Escape
   * fires `onGhostDismiss`. Only shown while the document is empty.
   */
  ghostText?: string;
  onGhostAccept?: () => void;
  onGhostDismiss?: () => void;
}

/**
 * Composer editor backed by Tiptap. Mention chips render as inline-block nodes
 * with a brand glyph + label — the layout impact is fine here (unlike the
 * textarea+mirror approach) because Tiptap manages caret position inside a
 * contenteditable, not a parallel native input.
 *
 * The suggestion plugin's render lifecycle is bridged to React state via the
 * `onSuggestionChange` callback; the parent renders its own palette UI rather
 * than the default tippy popup. Suggestion key handling is bridged via a ref
 * to avoid recreating the editor on every render.
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
  // Stable refs so the closures captured by Tiptap's extension config don't
  // need to be recreated on every parent render. The refs are mirrored from
  // the latest props in an effect below (not during render — a render-phase
  // ref write can leak if React discards the render); Tiptap's callbacks only
  // read them post-commit, so the timing is equivalent.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onSuggestionChangeRef = useRef(onSuggestionChange);
  const disabledRef = useRef(disabled);
  const ghostTextRef = useRef(ghostText);
  const onGhostAcceptRef = useRef(onGhostAccept);
  const onGhostDismissRef = useRef(onGhostDismiss);
  // Tracks whether the suggestion popup is open — used to skip Enter-submit
  // when the user is picking a mention.
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
        // `@<label>` round-trips through `editor.getText()` so plain-text
        // submission still carries the mention.
        renderText({ node }) {
          const label = node.attrs.label ?? node.attrs.id ?? "";
          return `@${label}`;
        },
        // Backspace immediately before a chip deletes the whole chip (default
        // behavior keeps the `@` floating around).
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
    content: initialJSON,
    autofocus: "end",
    editable: !disabled,
    editorProps: {
      attributes: {
        // ProseMirror's contenteditable is a generic element by default, where
        // `aria-label` is a prohibited attribute (axe `aria-prohibited-attr`).
        // `role="textbox"` + `aria-multiline` make it a named, multiline input
        // so the label is valid and AT announces it as a text field.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        class: cn(
          "tiptap tiptap-minimum-input composer-editor",
          "break-words whitespace-pre-wrap outline-none",
          "max-h-64 min-h-[64px] overflow-y-auto px-3 pt-2 pb-1.5",
          "text-[15px] leading-7 font-medium tracking-tight text-app-fg-4",
          "caret-app-purple-3",
          className ?? "",
        ),
      },
      handleKeyDown: (view, event) => {
        if (disabledRef.current) return true;
        // Suggestion popup handles its own keys via the suggestion plugin's
        // onKeyDown above. Only step in when it's closed.
        if (suggestionOpenRef.current) return false;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        // Ghost text (only live while the doc is empty): Tab accepts the
        // suggested prompt into the editor; Escape dismisses it for this turn.
        // `editor` is safely referenced from this deferred closure — keydowns
        // only fire after `useEditor` has assigned it.
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
          // Blur so global shortcuts (⌘K etc.) route correctly without
          // wrestling for focus.
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
        // Inspect the char immediately before the cursor — if it's not
        // whitespace or document-start, prepend a space so the `@` opens
        // the palette (suggestion's `allowedPrefixes` defaults to [' ']).
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
            // Same first-line position as the placeholder overlay below.
            "pointer-events-none absolute top-2 right-3 left-3",
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
            // Match the editor's first-line position (px-3 pt-2 from
            // composer-editor) so the overlay sits exactly where the cursor
            // starts. text-app-fg-2 keeps it readable in both themes.
            "pointer-events-none absolute top-2 left-3",
            "text-[15px] leading-7 font-medium tracking-tight text-app-fg-2",
            // Stardust transition — fades + slides + blurs out as the editor
            // fills. Spring-ish ease for a soft landing.
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
 * Inline chip rendered for each mention node. Built as an `inline-block` pill
 * with a brand glyph + label so it matches Dimension's chat composer parity —
 * the layout shift the textarea+mirror version couldn't tolerate is fine here
 * because Tiptap manages the caret inside a contenteditable, not a parallel
 * native input.
 */
function MentionChipNodeView({ node }: NodeViewProps) {
  const id: string = node.attrs.id ?? "";
  const label: string = node.attrs.label ?? id;
  const option = getMentionOption(id);
  const Icon = option?.icon;
  return (
    <NodeViewWrapper
      as="span"
      data-mention={id}
      className={cn(
        // Pristine pill: neutral subtle lift, brand identity carried by the
        // glyph rather than a saturated bg. Hairline inset ring defines the
        // edge without weight.
        "inline-flex items-center gap-[3px] align-baseline",
        "mx-[1px] rounded-[6px] px-1.5 py-px",
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
          <Icon size={11} strokeWidth={2} className="text-app-fg-3" />
        ) : null}
      </span>
      <span>@{label}</span>
    </NodeViewWrapper>
  );
}
