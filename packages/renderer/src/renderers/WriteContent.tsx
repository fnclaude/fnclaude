import { Box, Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { countLines } from "./summarize";

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
export function WriteContent({
  filePath,
  content,
  visibility,
}: WriteContentProps): JSX.Element | null {
  const header = `▸ Write: ${filePath}`;

  return (
    <Filtered
      visibility={visibility}
      hidden={<Text dimColor>{header}</Text>}
      summary={<Text>{`${header} (${countLines(content)} lines)`}</Text>}
      full={({ dim }) => (
        <Box flexDirection="column">
          <Text dimColor={dim}>{header}</Text>
          <Text dimColor={dim}>{content}</Text>
        </Box>
      )}
    />
  );
}
