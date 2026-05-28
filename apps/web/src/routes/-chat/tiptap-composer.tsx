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
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { filterMentionOptions, getMentionOption, type MentionOption } from "./mention-options";

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
  onChange: (text: string, json: JSONContent, isEmpty: boolean) => void;
  onSubmit: () => void;
  /** Suggestion lifecycle (start / update / exit). The parent renders its own palette UI. */
  onSuggestionChange: (state: SuggestionRenderState | null) => void;
  /** Keyboard handler invoked while the suggestion is active. Return `true` to consume the key. */
  suggestionKeyDownRef: React.MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
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
  onChange,
  onSubmit,
  onSuggestionChange,
  suggestionKeyDownRef,
}: TiptapComposerProps) {
  // Stable refs so the closures captured by Tiptap's extension config don't
  // need to be recreated on every parent render.
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onSuggestionChangeRef = useRef(onSuggestionChange);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitRef.current = onSubmit;
    onSuggestionChangeRef.current = onSuggestionChange;
  });

  // Tracks whether the suggestion popup is open — used to skip Enter-submit
  // when the user is picking a mention.
  const suggestionOpenRef = useRef(false);

  // Local empty state drives our custom animated placeholder overlay (replaces
  // Tiptap's built-in CSS placeholder so we can fade/slide/blur it out).
  const [isEmpty, setIsEmpty] = useState(true);

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
    editorProps: {
      attributes: {
        "aria-label": "Message",
        class: cn(
          "tiptap tiptap-minimum-input composer-editor",
          "outline-none whitespace-pre-wrap break-words",
          "min-h-[64px] max-h-64 overflow-y-auto px-3 pt-2 pb-1.5",
          "text-[15px] leading-7 font-medium tracking-tight text-vs-fg-4",
          "caret-vs-purple-3",
          className ?? "",
        ),
      },
      handleKeyDown: (view, event) => {
        // Suggestion popup handles its own keys via the suggestion plugin's
        // onKeyDown above. Only step in when it's closed.
        if (suggestionOpenRef.current) return false;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        if (event.key === "Escape") {
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
      setIsEmpty(empty);
      onChangeRef.current(editor.getText(), editor.getJSON(), empty);
    },
  });

  // Seed isEmpty from the initial doc so the overlay starts hidden when the
  // editor mounts with a draft.
  useEffect(() => {
    if (editor) setIsEmpty(editor.isEmpty);
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({
      focusEnd: () => editor?.commands.focus("end"),
      insertText: (text) => {
        if (!editor) return;
        editor.chain().focus("end").insertContent(text).run();
      },
      insertAtTrigger: () => {
        if (!editor) return;
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

  return (
    <div className="relative">
      <EditorContent editor={editor} />
      {placeholder ? (
        <span
          aria-hidden
          data-visible={isEmpty}
          className={cn(
            // Match the editor's first-line position (px-3 pt-2 from
            // composer-editor) so the overlay sits exactly where the cursor
            // starts. text-vs-fg-2 keeps it readable in both themes.
            "pointer-events-none absolute left-3 top-2",
            "text-[15px] leading-7 font-medium tracking-tight text-vs-fg-2",
            // Stardust transition — fades + slides + blurs out as the editor
            // fills. Spring-ish ease for a soft landing.
            "transition-[opacity,filter,transform] duration-300 ease-out",
            "data-[visible=true]:opacity-100 data-[visible=true]:blur-0 data-[visible=true]:translate-x-0",
            "data-[visible=false]:opacity-0 data-[visible=false]:blur-sm data-[visible=false]:translate-x-7",
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
        "px-1.5 py-px mx-[1px] rounded-[6px]",
        "bg-vs-bg-a2 text-vs-fg-4 font-medium",
        "ring-1 ring-inset ring-vs-fg-a1/20",
        "text-[0.92em] leading-[1.35]",
        "select-none cursor-default",
      )}
    >
      <span aria-hidden className="inline-flex shrink-0 items-center">
        {option?.brand ? (
          <IntegrationGlyph brand={option.brand} size={11} />
        ) : Icon ? (
          <Icon size={11} strokeWidth={2} className="text-vs-fg-3" />
        ) : null}
      </span>
      <span>@{label}</span>
    </NodeViewWrapper>
  );
}
