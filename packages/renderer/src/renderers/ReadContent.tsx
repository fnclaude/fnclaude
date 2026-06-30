import { Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { countLines } from "./summarize";

export interface ReadContentProps {
  filePath: string;
  content: string;
  visibility: Visibility;
}

/**
 * Renders the tool_result content of a Read tool call (large file body).
 * Filterable element id: "Read.content".
 *
 * Visibility:
 *   show     — full file content
 *   hide     — render nothing
 *   summary  — file path + line count of file
 *   dim      — full content, ANSI-faint
 */
export function ReadContent({
  filePath,
  content,
  visibility,
}: ReadContentProps): JSX.Element | null {
  return (
    <Filtered
      visibility={visibility}
      hidden={null}
      summary={<Text dimColor>{`  ↳ ${filePath} (${countLines(content)} lines)`}</Text>}
      full={({ dim }) => <Text dimColor={dim}>{content}</Text>}
    />
  );
}
