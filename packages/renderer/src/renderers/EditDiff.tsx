import { Box, Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { countLines } from "./summarize";

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
}: EditDiffProps): JSX.Element | null {
  const removedLines = countLines(oldString);
  const addedLines = countLines(newString);
  const removed = prefixLines(oldString, "- ");
  const added = prefixLines(newString, "+ ");

  return (
    <Filtered
      visibility={visibility}
      hidden={<Text dimColor>{`▸ Edit: ${filePath}`}</Text>}
      summary={
        <Text>
          {`▸ Edit: ${filePath} `}
          <Text color="red">{`-${removedLines}`}</Text>{" "}
          <Text color="green">{`+${addedLines}`}</Text>
          {" lines"}
        </Text>
      }
      full={({ dim }) =>
        dim ? (
          <Box flexDirection="column">
            <Text dimColor>{`▸ Edit: ${filePath}`}</Text>
            <Text dimColor>{removed}</Text>
            <Text dimColor>{added}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>{`▸ Edit: ${filePath}`}</Text>
            <Text color="red">{removed}</Text>
            <Text color="green">{added}</Text>
          </Box>
        )
      }
    />
  );
}
