import { Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { firstNLines } from "./summarize";

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
export function BashInput({
  command,
  description,
  visibility,
}: BashInputProps): JSX.Element | null {
  const header = `▸ Bash${description ? `: ${description}` : ""}`;
  const { head, hiddenLines } = firstNLines(command);

  return (
    <Filtered
      visibility={visibility}
      hidden={<Text dimColor>{header}</Text>}
      summary={
        <Text>
          {`$ ${head}`}
          {hiddenLines > 0 ? `\n(… ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"})` : ""}
        </Text>
      }
      full={({ dim }) => <Text dimColor={dim}>{`$ ${command}`}</Text>}
    />
  );
}
