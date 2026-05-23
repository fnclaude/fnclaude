import { Text } from "ink";

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
  const prefix = label ? `✖ ${label}: ` : "✖ ";
  return (
    <Text color="red" bold>
      {prefix}
      {message}
    </Text>
  );
}
