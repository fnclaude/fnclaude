import { Text } from "ink";
import type { SystemEvent } from "../types/events.ts";

export interface SystemInitProps {
  event: SystemEvent;
}

/**
 * One-line session header for SystemEvent.subtype === "init".
 * Mostly hidden by default; surfaces session_id, cwd, model on one line.
 */
export function SystemInit({ event }: SystemInitProps): JSX.Element {
  const parts: string[] = [`session=${event.session_id}`];
  if (event.cwd) parts.push(`cwd=${event.cwd}`);
  if (event.model) parts.push(`model=${event.model}`);
  return (
    <Text dimColor>
      {"▸ "}
      {parts.join(" ")}
    </Text>
  );
}
