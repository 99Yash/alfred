import { Children, type ReactNode } from "react";

/**
 * Fade each streamed word in. Keys are word indexes: the stream only appends,
 * so shown words keep their keys and do not replay the animation.
 */
export function animateWords(children: ReactNode): ReactNode {
  return Children.map(children, (child, childIndex) =>
    // Only raw strings split; inline elements pass through.
    typeof child === "string" ? wrapString(child, childIndex) : child,
  );
}

function wrapString(text: string, childIndex: number): ReactNode {
  // Keep whitespace tokens so spacing survives.
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
