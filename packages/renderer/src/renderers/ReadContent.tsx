import { Text } from "ink";
import type { Visibility } from "../types/events.ts";
import { countLines } from "./summarize.ts";

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
  if (visibility === "hide") return null;

  if (visibility === "summary") {
    return <Text dimColor>{`  ↳ ${filePath} (${countLines(content)} lines)`}</Text>;
  }

  if (visibility === "dim") {
    return <Text dimColor>{content}</Text>;
  }

  return <Text>{content}</Text>;
}
