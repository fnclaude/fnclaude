import { Box, Text } from "ink";
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
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text>{highlightCode(code, lang)}</Text>
    </Box>
  );
}
