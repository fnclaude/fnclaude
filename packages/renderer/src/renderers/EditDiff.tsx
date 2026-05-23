import { Box, Text } from "ink";
import type { Visibility } from "../types/events.ts";
import { countLines } from "./summarize.ts";

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export interface EditDiffProps {
  filePath: string;
  oldString: string;
  newString: string;
  visibility: Visibility;
}

/**
 * Renders an Edit tool_use: file path + minimal diff body.
 * Filterable element id: "Edit.diff".
 *
 * Visibility:
 *   show     — file path header + simple line-prefixed diff
 *   hide     — header only ("▸ Edit: <path>")
 *   summary  — file path + line count of change (e.g. "-2 +3 lines")
 *   dim      — full content, ANSI-faint
 */
export function EditDiff({
  filePath,
  oldString,
  newString,
  visibility,
}: EditDiffProps): JSX.Element {
  const removedLines = countLines(oldString);
  const addedLines = countLines(newString);

  if (visibility === "hide") {
    return <Text dimColor>{`▸ Edit: ${filePath}`}</Text>;
  }

  if (visibility === "summary") {
    return (
      <Text>
        {`▸ Edit: ${filePath} `}
        <Text color="red">{`-${removedLines}`}</Text> <Text color="green">{`+${addedLines}`}</Text>
        {" lines"}
      </Text>
    );
  }

  const removed = prefixLines(oldString, "- ");
  const added = prefixLines(newString, "+ ");

  if (visibility === "dim") {
    return (
      <Box flexDirection="column">
        <Text dimColor>{`▸ Edit: ${filePath}`}</Text>
        <Text dimColor>{removed}</Text>
        <Text dimColor>{added}</Text>
      </Box>
    );
  }

  // show
  return (
    <Box flexDirection="column">
      <Text>{`▸ Edit: ${filePath}`}</Text>
      <Text color="red">{removed}</Text>
      <Text color="green">{added}</Text>
    </Box>
  );
}
