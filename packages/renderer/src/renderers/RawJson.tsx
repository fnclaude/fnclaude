import { Text } from "ink";

export interface RawJsonProps {
  /** The value to render — serialized with JSON.stringify, 2-space indent. */
  value: unknown;
  /** Optional short label printed before the JSON (e.g. the event type). */
  label?: string;
}

/**
 * Last-resort faithful fallback: render any unmodeled event, unknown
 * tool_use/tool_result, or otherwise unrecognized payload as a dim raw-JSON
 * block. The point is "nothing is silently lost" — a styled per-type renderer
 * can supersede this later, but until then the raw shape is visible rather
 * than dropped to `return null`.
 */
export function RawJson({ value, label }: RawJsonProps): JSX.Element {
  let body: string;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  const prefix = label !== undefined ? `${label} ` : "";
  return <Text dimColor>{`▸ ${prefix}${body}`}</Text>;
}
