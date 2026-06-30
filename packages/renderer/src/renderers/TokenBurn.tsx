import { Text } from "ink";
import type { JSX } from "react";
import type { TokenUsage } from "../types/events";

export interface TokenBurnProps {
  usage: TokenUsage;
}

/**
 * Per-turn token-usage one-liner — the Alt+u filter POC. Presentational and
 * filter-agnostic: the caller decides whether to mount it (visibility +
 * usage presence). Renders a single dim row; the cache section is omitted
 * when both cache fields are absent or zero.
 */
export function TokenBurn({ usage }: TokenBurnProps): JSX.Element {
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const hasCache = created > 0 || read > 0;

  return (
    <Text dimColor>
      {`↑ ${fmt(usage.input_tokens)} in  ↓ ${fmt(usage.output_tokens)} out`}
      {hasCache ? ` [cache +${fmt(created)} /${fmt(read)} rd]` : ""}
    </Text>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
