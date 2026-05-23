import { Box, Text } from "ink";
import type { Visibility } from "../types/events.ts";
import { countLines } from "./summarize.ts";

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
export function TaskNested({ description, prompt, visibility }: TaskNestedProps): JSX.Element {
  const header = `▸ Task${description ? `: ${description}` : ""}`;

  if (visibility === "hide") {
    return <Text dimColor>{header}</Text>;
  }

  if (visibility === "summary") {
    const firstLine = prompt.split("\n", 1)[0] ?? "";
    const total = countLines(prompt);
    return <Text>{`${header}\n  ${firstLine} (${total} lines)`}</Text>;
  }

  if (visibility === "dim") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{header}</Text>
        <Text dimColor>{prompt}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{header}</Text>
      <Text>{prompt}</Text>
    </Box>
  );
}
