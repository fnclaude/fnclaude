import { Box, Text } from "ink";
import type { JSX } from "react";
import type { Visibility } from "../types/events";
import { Filtered } from "./Filtered";
import { StructuredValue } from "./StructuredValue";

export interface GenericToolProps {
  /** One-line header, e.g. "▸ Glob". Shown in every non-hidden state. */
  header: string;
  /** The payload rendered as a key/value body: tool_use input or a parsed
   *  tool_result. Strings/objects/arrays all lay out via StructuredValue. */
  body: unknown;
  /** The single salient arg appended to the header in `summary` mode
   *  (command / path / url / pattern). Omitted → summary is header-only. */
  salient?: string | undefined;
  /** Element-level visibility, resolved from the shared `tool.generic` id. */
  visibility: Visibility;
  /**
   * Stable per-block id — the originating `tool_use` id. Threaded purely to
   * key the per-instance expand override below; nothing reads it yet.
   */
  blockId?: string | undefined;
  /**
   * Per-INSTANCE expand seam for #285. When a block has been expanded in
   * place (terse→verbose for this one call, keyed by {@link blockId}), this
   * resolver returns the override; it is consulted AHEAD of the element-level
   * {@link visibility}. Inert until the SGR mouse path lands — no caller
   * passes it today, so the `?? visibility` fallback always wins.
   */
  instanceVisibility?: ((blockId: string) => Visibility | undefined) | undefined;
}

/**
 * The generic structured tool renderer — the fallback for any tool without a
 * bespoke view (Grep, Glob, WebFetch, TodoWrite, every MCP tool). Built on the
 * single {@link Filtered} visibility dispatcher rather than a hand-rolled
 * four-state ladder:
 *
 *   hide     — header only
 *   summary  — one line: header + salient arg
 *   dim/show — header + full key/value body (dimmed for `dim`)
 */
export function GenericTool({
  header,
  body,
  salient,
  visibility,
  blockId,
  instanceVisibility,
}: GenericToolProps): JSX.Element | null {
  const effective =
    (blockId !== undefined ? instanceVisibility?.(blockId) : undefined) ?? visibility;
  const summaryLine = salient !== undefined && salient.length > 0 ? `${header} ${salient}` : header;

  return (
    <Filtered
      visibility={effective}
      hidden={<Text dimColor>{header}</Text>}
      summary={<Text>{summaryLine}</Text>}
      full={({ dim }) => (
        <Box flexDirection="column">
          <Text dimColor={dim}>{header}</Text>
          <Box marginLeft={2} flexDirection="column">
            <StructuredValue value={body} dim={dim} />
          </Box>
        </Box>
      )}
    />
  );
}

/** Keys checked first when picking the salient arg for a summary line — the
 *  same tool-specific "what matters" the bespoke summaries encode. */
const SALIENT_KEYS = [
  "command",
  "file_path",
  "url",
  "pattern",
  "query",
  "prompt",
  "path",
  "description",
];

const SALIENT_MAX = 80;

/**
 * The one arg worth showing on a summary line: a preferred key if present,
 * else the first string-valued entry. Multi-line/long values are collapsed to
 * a truncated first line so the summary stays one line.
 */
export function salientArg(input: Record<string, unknown>): string | undefined {
  for (const key of SALIENT_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return firstLine(v);
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) return firstLine(v);
  }
  return undefined;
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > SALIENT_MAX ? `${line.slice(0, SALIENT_MAX - 1)}…` : line;
}

/**
 * Coerce a tool_result body into a structured value: JSON that parses to an
 * object/array is laid out as key/value; anything else (plain text, a bare
 * number, invalid JSON) stays a string so it renders verbatim.
 */
export function coerceStructured(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.length === 0) return content;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return content;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // not JSON — fall through to the raw string
  }
  return content;
}
