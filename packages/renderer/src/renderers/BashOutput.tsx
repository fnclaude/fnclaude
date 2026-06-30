import { Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { firstNLines } from "./summarize";

export interface BashOutputProps {
  content: string;
  visibility: Visibility;
  isError?: boolean | undefined;
}

/**
 * Renders the tool_result output of a Bash invocation.
 * Filterable element id: "Bash.output".
 *
 * Visibility:
 *   show     — full output
 *   hide     — render nothing
 *   summary  — first 5 lines + "(… N lines hidden)"
 *   dim      — full output, ANSI-faint
 */
export function BashOutput({
  content,
  visibility,
  isError,
}: BashOutputProps): JSX.Element | null {
  const { head, hiddenLines } = firstNLines(content);
  const summaryBody = `${head}${hiddenLines > 0 ? `\n(… ${hiddenLines} lines hidden)` : ""}`;

  return (
    <Filtered
      visibility={visibility}
      hidden={null}
      summary={isError ? <Text color="red">{summaryBody}</Text> : <Text>{summaryBody}</Text>}
      full={({ dim }) =>
        dim ? (
          <Text dimColor>{content}</Text>
        ) : isError ? (
          <Text color="red">{content}</Text>
        ) : (
          <Text>{content}</Text>
        )
      }
    />
  );
}
