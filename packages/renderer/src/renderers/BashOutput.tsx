import { Text } from "ink";
import type { Visibility } from "../types/events.ts";
import { firstNLines } from "./summarize.ts";

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
export function BashOutput({ content, visibility, isError }: BashOutputProps): JSX.Element | null {
  if (visibility === "hide") return null;

  if (visibility === "summary") {
    const { head, hiddenLines } = firstNLines(content);
    const body = `${head}${hiddenLines > 0 ? `\n(… ${hiddenLines} lines hidden)` : ""}`;
    return isError ? <Text color="red">{body}</Text> : <Text>{body}</Text>;
  }

  if (visibility === "dim") {
    return <Text dimColor>{content}</Text>;
  }

  // show
  return isError ? <Text color="red">{content}</Text> : <Text>{content}</Text>;
}
