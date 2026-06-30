import { Text } from "ink";
import type { JSX } from "react";
import { useRendererTheme } from "../theme.tsx";

export interface ErrorRendererProps {
  message: string;
  /** Optional label, e.g. tool name or "result". */
  label?: string;
}

/**
 * Error renderer for any block with is_error: true and ResultEvent with
 * is_error: true. Always shown (errors element defaults to "show" on every
 * preset; respects overrides only if the user explicitly hides errors).
 */
export function ErrorRenderer({ message, label }: ErrorRendererProps): JSX.Element {
  const theme = useRendererTheme();
  const prefix = label ? `✖ ${label}: ` : "✖ ";
  return (
    <Text color={theme.error} bold>
      {prefix}
      {message}
    </Text>
  );
}
