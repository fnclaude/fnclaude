/**
 * Line-buffered NDJSON parser for claude's stream-json output.
 *
 * Reads a ReadableStream<Uint8Array> and yields parsed ClaudeEvent objects.
 * Designed for Bun.spawn's stdout stream.
 *
 * Design notes:
 * - Buffers bytes across chunks and splits on `\n`. Lines can be ~3KB+ in
 *   practice (system/init lines embed all slash commands and tool names);
 *   the 64KB default chunk size for the dynamic buffer is intentionally
 *   generous. There is no per-line cap.
 * - Partial trailing data (no terminating `\n` when the stream closes) is
 *   silently dropped — this matches observed behaviour where the process
 *   always terminates cleanly with a fully-written result line.
 * - JSON.parse errors on individual lines are silently dropped so that
 *   unexpected diagnostic output or future unknown event types do not break
 *   callers. The parser is meant to be forward-compatible.
 */
import type { ClaudeEvent } from "./types/events.ts";

const NEWLINE = 0x0a; // '\n'

export async function* parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ClaudeEvent> {
  const reader = stream.getReader();

  // Dynamic byte accumulator — grows on demand.
  let buf = new Uint8Array(64 * 1024);
  let bufLen = 0;

  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value !== undefined) {
        // Grow buffer if needed.
        while (bufLen + value.length > buf.length) {
          const next = new Uint8Array(buf.length * 2);
          next.set(buf.subarray(0, bufLen));
          buf = next;
        }
        buf.set(value, bufLen);
        bufLen += value.length;
      }

      // Drain all complete lines from the buffer.
      let start = 0;
      while (start < bufLen) {
        const newlinePos = buf.subarray(start, bufLen).indexOf(NEWLINE);
        if (newlinePos === -1) break;

        const lineEnd = start + newlinePos;
        const line = decoder.decode(buf.subarray(start, lineEnd)).trim();
        start = lineEnd + 1;

        if (line.length === 0) continue;

        const event = tryParseLine(line);
        if (event !== null) yield event;
      }

      // Compact: move remaining bytes to front.
      if (start > 0) {
        buf.copyWithin(0, start, bufLen);
        bufLen -= start;
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  // Any bytes remaining in buf are a partial line — silently dropped.
}

function tryParseLine(line: string): ClaudeEvent | null {
  try {
    const obj = JSON.parse(line) as unknown;
    if (obj !== null && typeof obj === "object" && "type" in obj) {
      return obj as ClaudeEvent;
    }
    return null;
  } catch {
    return null;
  }
}
