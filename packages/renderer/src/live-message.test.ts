/**
 * Tests for the live-message reducer — the pure accumulation/finalize logic
 * behind token-level streaming. No subprocess, no React: feed fixture
 * StreamEvent[] through the reducer and assert state.
 *
 * Every test here fails against the pre-streaming tree (no reducer module).
 */
import { describe, expect, test } from "bun:test";
import {
  assistantMsg1Text,
  assistantMsg1Tool,
  assistantMsg2,
  streamMsg1,
  streamMsg2,
  streamThinking,
} from "./__fixtures__/stream-events";
import { emptyLive, finalizeForAssistant, inFlightBlocks, liveReducer } from "./live-message";

/** Fold a sequence of stream events through the reducer from empty. */
function fold(events: typeof streamMsg1, start = emptyLive()) {
  let state = start;
  for (const ev of events) state = liveReducer(state, ev);
  return state;
}

describe("liveReducer — accumulation", () => {
  test("text_deltas concatenate into the block body before any assistant event", () => {
    const state = fold(streamMsg1);
    const block = state?.blocks.get(0);
    expect(block?.type).toBe("text");
    // "Hi" + "\n\nNow the file:" — exact concatenation of the two deltas.
    expect(block?.text).toBe("Hi\n\nNow the file:");
  });

  test("input_json_delta accumulates raw, never JSON.parsed mid-stream", () => {
    const state = fold(streamMsg1);
    const block = state?.blocks.get(1);
    expect(block?.type).toBe("tool_use");
    expect(block?.toolName).toBe("Read");
    // Raw concatenation of '' + '{"file_path": "/tmp/parity-probe.txt' + '"}'.
    expect(block?.partialJson).toBe('{"file_path": "/tmp/parity-probe.txt"}');
    // The live text body for a tool_use stays empty — no parsed input leaks in.
    expect(block?.text).toBe("");
  });

  test("thinking_delta accumulates; signature_delta does not leak into display text", () => {
    const state = fold(streamThinking);
    const block = state?.blocks.get(0);
    expect(block?.type).toBe("thinking");
    expect(block?.text).toBe("Let me reason about this");
    // The opaque signature must never appear in the rendered preview body.
    expect(block?.text).not.toContain("OPAQUE_SIG_BASE64");
  });
});

describe("liveReducer — index isolation across messages", () => {
  test("message 2 reusing index 0 does not contaminate message 1's block", () => {
    // Fold message 1 to completion, finalize both its blocks, then message 2.
    let state = fold(streamMsg1);
    state = finalizeForAssistant(state, assistantMsg1Text);
    state = finalizeForAssistant(state, assistantMsg1Tool);
    state = fold(streamMsg2, state);
    // The live state is now message 2's; its idx-0 text is message 2's, not
    // message 1's "Hi…".
    expect(state?.id).toBe(assistantMsg2.message.id);
    expect(state?.blocks.get(0)?.text).toBe("The file contains three lines.");
  });
});

describe("finalizeForAssistant — drop on truth", () => {
  test("a finalized block stops being in-flight", () => {
    let state = fold(streamMsg1);
    // Both blocks are in-flight before any assistant event.
    expect(inFlightBlocks(state).map((b) => b.index)).toEqual([0, 1]);

    state = finalizeForAssistant(state, assistantMsg1Text);
    // idx 0 finalized → only idx 1 remains in-flight.
    expect(inFlightBlocks(state).map((b) => b.index)).toEqual([1]);

    state = finalizeForAssistant(state, assistantMsg1Tool);
    // Both finalized → nothing in-flight.
    expect(inFlightBlocks(state)).toEqual([]);
  });

  test("an assistant event for a different message id leaves live state intact", () => {
    const state = fold(streamMsg1);
    const after = finalizeForAssistant(state, assistantMsg2);
    // A concrete *different* id means a different message — don't advance.
    expect(inFlightBlocks(after).map((b) => b.index)).toEqual([0, 1]);
  });

  test("finalizes the preview when both the live message and assistant event lack an id", () => {
    // A message_start with no id leaves state.id === "" (id is optional). The
    // matching assistant event can also arrive without an id. The old strict
    // `event.message.id !== state.id` check bailed here (undefined !== ""), so
    // the preview never finalized and rendered alongside the committed block —
    // the visible double-render. Fall back to block-index matching instead.
    let state = liveReducer(emptyLive(), {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-8", role: "assistant", content: [] },
      },
      session_id: "s",
      uuid: "ms",
    });
    state = liveReducer(state, {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      session_id: "s",
      uuid: "cbs",
    });
    state = liveReducer(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      session_id: "s",
      uuid: "cbd",
    });
    expect(inFlightBlocks(state).map((b) => b.index)).toEqual([0]);

    // Consolidated assistant event with NO message.id.
    state = finalizeForAssistant(state, {
      type: "assistant",
      session_id: "s",
      uuid: "a",
      message: {
        model: "claude-opus-4-8",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    });
    // The block is consumed → nothing in flight, so the preview is dropped and
    // only the committed render remains.
    expect(inFlightBlocks(state)).toEqual([]);
  });
});

describe("inFlightBlocks — null/empty states", () => {
  test("empty live state has no in-flight blocks", () => {
    expect(inFlightBlocks(emptyLive())).toEqual([]);
  });
});
