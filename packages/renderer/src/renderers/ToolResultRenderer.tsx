import { Text } from "ink";
import type { ElementId, ToolResultBlock, Visibility } from "../types/events.ts";
import { BashOutput } from "./BashOutput.tsx";
import { ErrorRenderer } from "./ErrorRenderer.tsx";
import { ReadContent } from "./ReadContent.tsx";

export interface ToolResultRendererProps {
  block: ToolResultBlock;
  /**
   * Tool name resolved from the originating tool_use's id. Slice B maintains
   * a tool_use_id → tool_name map (the cleanest representation: it lives
   * naturally in the event-log reducer where both halves of the pair are
   * observed) and passes the name in here.
   */
  toolName: string;
  /**
   * Optional tool_use input — needed for results that summarize against
   * the call (e.g. Read.content's summary form wants the file_path).
   * Pass-through from slice B's map; omitted if not relevant.
   */
  toolInput?: Record<string, unknown>;
  visibilityFor: (id: ElementId) => Visibility;
}

/**
 * Generic dispatcher for ToolResultBlocks. Maps the originating tool name
 * to the right per-result component (BashOutput, ReadContent, …). Errors
 * (is_error: true) always delegate to ErrorRenderer regardless of tool.
 */
export function ToolResultRenderer({
  block,
  toolName,
  toolInput,
  visibilityFor,
}: ToolResultRendererProps): JSX.Element | null {
  const content = stringifyContent(block.content);

  if (block.is_error) {
    return <ErrorRenderer message={content} label={toolName} />;
  }

  switch (toolName) {
    case "Bash":
      return <BashOutput content={content} visibility={visibilityFor("Bash.output")} />;

    case "Read": {
      const fp = toolInput?.file_path;
      return (
        <ReadContent
          filePath={typeof fp === "string" ? fp : ""}
          content={content}
          visibility={visibilityFor("Read.content")}
        />
      );
    }

    default:
      // No dedicated component — render the result body as plain text.
      return <Text>{content}</Text>;
  }
}

function stringifyContent(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => b.text).join("");
}
