import { Children, type ReactNode } from "react";

/**
 * Wrap the text runs of a streamed markdown node so each word fades up out of
 * a blur as it arrives (the `.animate-chat-word` keyframe). Adapted from
 * dimension's `animate-text`: we split on words and key each by index so that,
 * because streaming is append-only, already-shown words keep their key (React
 * reuses the node → its `forwards` animation stays finished and does not
 * replay) while only the freshly-appended tail animates in.
 *
 * Non-text children (inline `<strong>`, `<code>`, links) pass through
 * untouched — splitting only ever touches raw strings.
 */
export function animateWords(children: ReactNode): ReactNode {
  return Children.map(children, (child, childIndex) =>
    // Only raw strings get word-split; inline elements (`<strong>`, `<code>`,
    // links) pass through so we never restructure their subtrees.
    typeof child === "string" ? wrapString(child, childIndex) : child,
  );
}

function wrapString(text: string, childIndex: number): ReactNode {
  // Split keeping the whitespace tokens so spacing survives the round-trip.
  let offset = 0;
  return text.split(/(\s+)/).map((token) => {
    const start = offset;
    offset += token.length;
    if (token === "" || /^\s+$/.test(token)) return token;
    return (
      <span key={`w-${childIndex}-${start}-${token}`} className="animate-chat-word">
        {token}
      </span>
    );
  });
}
