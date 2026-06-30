import { Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";

export interface ThinkingRendererProps {
  thinking: string;
  visibility: Visibility;
}

/**
 * Renders a ThinkingBlock. Filterable element id: "thinking".
 *
 * Visibility semantics (see docs/filter-state-spec.md):
 *   show      — full content (dim styling because thinking is meta)
 *   hide      — render nothing
 *   summary   — first sentence + "(thinking continues)" if more
 *   dim       — full content with ANSI faint
 */
export function ThinkingRenderer({
  thinking,
  visibility,
}: ThinkingRendererProps): JSX.Element | null {
  const { head, hasMore } = firstSentence(thinking);

  return (
    <Filtered
      visibility={visibility}
      hidden={null}
      summary={
        <Text dimColor>
          {"💭 "}
          {head}
          {hasMore ? " (thinking continues)" : ""}
        </Text>
      }
      // show and dim both render full content with dim styling. Thinking is
      // always rendered dim — "show" just means "full body visible at all".
      full={() => (
        <Text dimColor>
          {"💭 "}
          {thinking}
        </Text>
      )}
    />
  );
}

function firstSentence(text: string): { head: string; hasMore: boolean } {
  const trimmed = text.trim();
  // Match up to and including the first sentence terminator.
  const m = trimmed.match(/^.*?[.!?](?=\s|$)/);
  if (!m) return { head: trimmed, hasMore: false };
  const head = m[0];
  return { head, hasMore: head.length < trimmed.length };
}
