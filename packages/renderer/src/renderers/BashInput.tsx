import { Text } from "ink";
import type { Visibility } from "../types/events.ts";
import { firstNLines } from "./summarize.ts";

export interface BashInputProps {
  command: string;
  description?: string | undefined;
  visibility: Visibility;
}

/**
 * Renders the `command` field of a Bash tool_use block.
 * Filterable element id: "Bash.input".
 *
 * Visibility:
 *   show     — full command
 *   hide     — single-line "▸ Bash: <description>" header only
 *   summary  — first 5 lines (+ "N more lines" indicator for multi-line)
 *   dim      — full command, ANSI-faint
 */
export function BashInput({ command, description, visibility }: BashInputProps): JSX.Element {
  const header = `▸ Bash${description ? `: ${description}` : ""}`;

  if (visibility === "hide") {
    return <Text dimColor>{header}</Text>;
  }

  if (visibility === "summary") {
    const { head, hiddenLines } = firstNLines(command);
    return (
      <Text>
        {`$ ${head}`}
        {hiddenLines > 0 ? `\n(… ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"})` : ""}
      </Text>
    );
  }

  if (visibility === "dim") {
    return <Text dimColor>{`$ ${command}`}</Text>;
  }

  // show
  return <Text>{`$ ${command}`}</Text>;
}
