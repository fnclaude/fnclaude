import { Box, Text } from "ink";
import { type JSX, useMemo } from "react";
import { highlightCode } from "./highlight.ts";

export interface CodeBlockProps {
  code: string;
  lang?: string | undefined;
}

/**
 * Renders a fenced code block inside a rounded gray border, with optional
 * syntax highlighting via cli-highlight.
 */
export function CodeBlock({ code, lang }: CodeBlockProps): JSX.Element {
  // Memoize syntax highlighting so a top-level re-render (e.g. a keystroke)
  // doesn't re-run cli-highlight over every committed code block.
  const highlighted = useMemo(() => highlightCode(code, lang), [code, lang]);
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text>{highlighted}</Text>
    </Box>
  );
}
