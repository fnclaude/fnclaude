/**
 * Hermetic stream_event fixtures for the live-block reducer + App streaming
 * tests. Shapes are faithful to a live `--include-partial-messages` capture
 * (see stream-partial-turn.ndjson, captured from claude-opus-4-8); trimmed to
 * the fields the reducer reads. The thinking sequence carries a visible
 * `thinking_delta` (the live spike only produced a redacted signature-only
 * thinking block, so the visible-text path is authored here to exercise it).
 *
 * Convention: `M1` is the first assistant message id, `M2` the second.
 * Block `index` resets to 0 per message — that reset is exactly what the
 * `(message.id, index)` keying must survive.
 */

import type { AssistantEvent, StreamEvent } from "../types/events";

const M1 = "msg_text_tool";
const M2 = "msg_answer";

/**
 * Message 1: a text block (idx 0) streamed in two text_deltas, then a
 * tool_use block (idx 1, Read) streamed as four input_json_delta chunks
 * including the canonical empty leading chunk.
 */
export const streamMsg1: StreamEvent[] = [
  {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: M1, model: "claude-opus-4-8", role: "assistant", content: [] },
    },
    session_id: "s1",
    uuid: "se-1",
    ttft_ms: 1328,
  },
  {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    session_id: "s1",
    uuid: "se-2",
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    session_id: "s1",
    uuid: "se-3",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "\n\nNow the file:" },
    },
    session_id: "s1",
    uuid: "se-4",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    },
    session_id: "s1",
    uuid: "se-5",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "" },
    },
    session_id: "s1",
    uuid: "se-6",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path": "/tmp/parity-probe.txt' },
    },
    session_id: "s1",
    uuid: "se-7",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"}' },
    },
    session_id: "s1",
    uuid: "se-8",
  },
];

/** The consolidated `assistant` event for message 1's text block (idx 0). */
export const assistantMsg1Text: AssistantEvent = {
  type: "assistant",
  session_id: "s1",
  uuid: "a-1",
  message: {
    id: M1,
    model: "claude-opus-4-8",
    role: "assistant",
    content: [{ type: "text", text: "Hi\n\nNow the file:" }],
  },
};

/** The consolidated `assistant` event for message 1's tool_use block (idx 1). */
export const assistantMsg1Tool: AssistantEvent = {
  type: "assistant",
  session_id: "s1",
  uuid: "a-2",
  message: {
    id: M1,
    model: "claude-opus-4-8",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "/tmp/parity-probe.txt" },
      },
    ],
  },
};

/**
 * Message 2: a fresh assistant message whose single text block reuses
 * `index: 0` — the reset that proves `(message.id, index)` keying.
 */
export const streamMsg2: StreamEvent[] = [
  {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: M2, model: "claude-opus-4-8", role: "assistant", content: [] },
    },
    session_id: "s1",
    uuid: "se-9",
  },
  {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    session_id: "s1",
    uuid: "se-10",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "The file contains three lines." },
    },
    session_id: "s1",
    uuid: "se-11",
  },
];

export const assistantMsg2: AssistantEvent = {
  type: "assistant",
  session_id: "s1",
  uuid: "a-3",
  message: {
    id: M2,
    model: "claude-opus-4-8",
    role: "assistant",
    content: [{ type: "text", text: "The file contains three lines." }],
  },
};

/**
 * A thinking block (idx 0) streamed as a visible `thinking_delta` followed
 * by the opaque `signature_delta`. The signature must NOT appear in the
 * accumulated display text — only the thinking text does.
 */
export const streamThinking: StreamEvent[] = [
  {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: "msg_think", model: "claude-opus-4-8", role: "assistant", content: [] },
    },
    session_id: "s1",
    uuid: "st-1",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    session_id: "s1",
    uuid: "st-2",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me reason about this" },
    },
    session_id: "s1",
    uuid: "st-3",
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "OPAQUE_SIG_BASE64" },
    },
    session_id: "s1",
    uuid: "st-4",
  },
];
