import { Box, Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { countLines } from "./summarize";

export interface TaskNestedProps {
  description?: string | undefined;
  prompt: string;
  visibility: Visibility;
}

/**
 * Renders a Task tool_use: prompt sent to a subagent.
 * Filterable element id: "Task.nested".
 *
 * Visibility:
 *   show     — full subagent prompt
 *   hide     — header only ("▸ Task: <description>")
 *   summary  — first line of prompt + line count
 *   dim      — full prompt, ANSI-faint
 */
export function TaskNested({
  description,
  prompt,
  visibility,
}: TaskNestedProps): JSX.Element | null {
  const header = `▸ Task${description ? `: ${description}` : ""}`;
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const total = countLines(prompt);

  return (
    <Filtered
      visibility={visibility}
      hidden={<Text dimColor>{header}</Text>}
      summary={<Text>{`${header}\n  ${firstLine} (${total} lines)`}</Text>}
      full={({ dim }) => (
        <Box flexDirection="column">
          <Text dimColor={dim}>{header}</Text>
          <Text dimColor={dim}>{prompt}</Text>
        </Box>
      )}
    />
  );
}
