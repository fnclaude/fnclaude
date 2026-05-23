import { Text } from "ink";
import type { ResultEvent } from "../types/events.ts";
import { ErrorRenderer } from "./ErrorRenderer.tsx";

export interface ResultRendererProps {
  event: ResultEvent;
}

/**
 * Renders a ResultEvent. The `result` text is always shown (status-line
 * style). Two special cases:
 *
 *   - is_error: true            → delegate to ErrorRenderer (red bold).
 *   - "Unknown command:" prefix → soft warning (yellow), per
 *     docs/stream-json-findings.md: claude reports unknown slash commands
 *     via result.result with is_error: false.
 */
export function ResultRenderer({ event }: ResultRendererProps): JSX.Element {
  if (event.is_error) {
    return <ErrorRenderer message={event.result} label="result" />;
  }
  if (event.result.startsWith("Unknown command:")) {
    return <Text color="yellow">{event.result}</Text>;
  }
  return <Text>{event.result}</Text>;
}
