import { Box, Text } from "ink";
import type { JSX } from "react";

/**
 * Strings at or under this length (and single-line) render inline next to
 * their key; anything longer drops to an indented sub-block so the key row
 * stays scannable.
 */
const INLINE_STRING_MAX = 80;

export interface StructuredValueProps {
  /** Any JSON-ish value: object, array, string, number, boolean, null. */
  value: unknown;
  /** ANSI-faint the value text (the "dim" visibility state). Keys stay dim
   *  regardless — dim keys are the readable-key/value convention. */
  dim?: boolean;
}

/**
 * Recursive key/value renderer for arbitrary tool payloads. Objects lay out
 * one dimmed-key row per entry; arrays lay out one bulleted row per element;
 * scalars render inline. Long or nested values indent into a sub-block rather
 * than collapsing to a single `JSON.stringify` line — the point is a readable
 * shape, not a faithful serialization (that's what {@link RawJson} is for).
 */
export function StructuredValue({ value, dim = false }: StructuredValueProps): JSX.Element {
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text dimColor>{"(empty)"}</Text>;
    return (
      <Box flexDirection="column">
        {value.map((item, i) => (
          // Index is a stable key here: the array is a static render input.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional payload rows
          <Box key={i} flexDirection="row">
            <Text dimColor>{"- "}</Text>
            <Box flexDirection="column" flexGrow={1}>
              <StructuredValue value={item} dim={dim} />
            </Box>
          </Box>
        ))}
      </Box>
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <Text dimColor>{"(empty)"}</Text>;
    return (
      <Box flexDirection="column">
        {entries.map(([k, v]) => (
          <KeyRow key={k} label={k} value={v} dim={dim} />
        ))}
      </Box>
    );
  }

  return <Text dimColor={dim}>{scalarText(value)}</Text>;
}

/**
 * One object entry. Inline scalars sit on the key row (`key: value`); long
 * strings, arrays, and nested objects put the key on its own line with the
 * value indented beneath it.
 */
function KeyRow({
  label,
  value,
  dim = false,
}: {
  label: string;
  value: unknown;
  dim?: boolean;
}): JSX.Element {
  if (isInlineScalar(value)) {
    return (
      <Box flexDirection="row">
        <Text dimColor>{`${label}: `}</Text>
        <Text dimColor={dim} wrap="truncate-end">
          {scalarText(value)}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${label}:`}</Text>
      <Box marginLeft={2} flexDirection="column">
        <StructuredValue value={value} dim={dim} />
      </Box>
    </Box>
  );
}

/** True for values that render on the same row as their key. */
function isInlineScalar(v: unknown): boolean {
  if (v === null || typeof v === "number" || typeof v === "boolean") return true;
  return typeof v === "string" && v.length <= INLINE_STRING_MAX && !v.includes("\n");
}

function scalarText(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return String(v);
}
