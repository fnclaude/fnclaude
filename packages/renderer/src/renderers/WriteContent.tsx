import { Box, Text } from "ink";
import type { Visibility } from "../types/events.ts";
import { countLines } from "./summarize.ts";

export interface WriteContentProps {
  filePath: string;
  content: string;
  visibility: Visibility;
}

/**
 * Renders a Write tool_use: file path + new file content.
 * Filterable element id: "Write.content".
 *
 * Visibility:
 *   show     — file path header + full body
 *   hide     — header only ("▸ Write: <path>")
 *   summary  — file path + line count of new content
 *   dim      — full body, ANSI-faint
 */
export function WriteContent({ filePath, content, visibility }: WriteContentProps): JSX.Element {
  const header = `▸ Write: ${filePath}`;

  if (visibility === "hide") {
    return <Text dimColor>{header}</Text>;
  }

  if (visibility === "summary") {
    return <Text>{`${header} (${countLines(content)} lines)`}</Text>;
  }

  if (visibility === "dim") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{header}</Text>
        <Text dimColor>{content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{header}</Text>
      <Text>{content}</Text>
    </Box>
  );
}
