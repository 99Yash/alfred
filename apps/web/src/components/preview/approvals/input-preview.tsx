import { stringArray, stringValue } from "./helpers";
import { PreviewField } from "./preview-field";
import { PreviewGrid } from "./preview-grid";
import type { ToolName } from "./types";

export function InputPreview({
  toolName,
  input,
}: {
  toolName: ToolName;
  input: Record<string, unknown>;
}) {
  if (toolName === "gmail.send_draft") {
    return (
      <PreviewGrid>
        <PreviewField label="To" value={stringArray(input.to).join(", ")} />
        <PreviewField label="Cc" value={stringArray(input.cc).join(", ")} />
        <PreviewField label="Subject" value={stringValue(input.subject)} />
        <PreviewField label="Thread" value={stringValue(input.threadId)} />
        <PreviewField label="Body" value={stringValue(input.bodyText)} multiline />
      </PreviewGrid>
    );
  }
  return (
    <PreviewGrid>
      <PreviewField label="Summary" value={stringValue(input.summary)} />
      <PreviewField label="Start" value={stringValue(input.start)} />
      <PreviewField label="End" value={stringValue(input.end)} />
      <PreviewField label="Attendees" value={stringArray(input.attendees).join(", ")} />
      <PreviewField label="Description" value={stringValue(input.description)} multiline />
    </PreviewGrid>
  );
}
