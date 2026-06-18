/**
 * Live-message reducer: accumulates `stream_event` deltas into a transient
 * in-progress assistant message for token-level preview rendering.
 *
 * Design (see docs/stream-json-findings.md, "token-level streaming"):
 *
 * claude emits one consolidated `assistant` event per content block, mid-
 * stream, carrying the *complete* block — so the deltas are only a latency/UX
 * preview, never the source of truth. The reducer therefore does NOT have to
 * reconstruct canonical blocks; it builds a cheap live view and hands off the
 * instant the matching `assistant` event lands.
 *
 * Keying: block `index` resets to 0 per message, so live state is scoped to a
 * single `message.id` (from `message_start`). A fresh `message_start` replaces
 * the prior LiveMessage — safe, because by then all of its blocks are
 * committed.
 *
 * Finalize-on-truth: `committedCount` counts the `assistant` events seen for
 * the current `message.id`. Blocks with `index >= committedCount` are still
 * in flight and get drawn from the live view; the rest are drawn (identically)
 * from the committed event log. This self-clears with no duplicate render.
 */

import type { AssistantEvent, ContentBlock, StreamEvent } from "./types/events.ts";

export type LiveBlockType = "text" | "thinking" | "tool_use";

export interface LiveBlock {
  index: number;
  type: LiveBlockType;
  /** Accumulated visible body (text/thinking). Empty for tool_use. */
  text: string;
  /** tool_use only: name from content_block_start. */
  toolName?: string;
  /** tool_use only: accumulating partial_json — NEVER JSON.parsed mid-stream. */
  partialJson: string;
}

export interface LiveMessage {
  id: string;
  model: string;
  blocks: Map<number, LiveBlock>;
  /** Number of consolidated `assistant` events seen for this message id. */
  committedCount: number;
  /** Set on message_stop (cosmetic; real teardown is finalize). */
  done: boolean;
}

/** The transient streaming state: either an in-progress message or nothing. */
export type LiveState = LiveMessage | null;

export function emptyLive(): LiveState {
  return null;
}

/**
 * Fold one `stream_event` into the live state. Returns a NEW LiveMessage on
 * every state-changing transition (the contained blocks are cloned too) so
 * React's `useState` reference check always sees a change and re-renders. A
 * transition that changes nothing returns the same reference (a deliberate
 * no-op bail-out — `content_block_stop`/`message_delta`).
 */
export function liveReducer(state: LiveState, event: StreamEvent): LiveState {
  const inner = event.event;
  switch (inner.type) {
    case "message_start": {
      // A new message supersedes the prior live one (its blocks are committed
      // by now). Seed fresh state keyed on the new message id.
      return {
        id: inner.message.id ?? "",
        model: inner.message.model,
        blocks: new Map(),
        committedCount: 0,
        done: false,
      };
    }
    case "content_block_start": {
      if (state === null) return state;
      const block = seedBlock(inner.index, inner.content_block);
      if (block === null) return state;
      const blocks = new Map(state.blocks);
      blocks.set(inner.index, block);
      return { ...state, blocks };
    }
    case "content_block_delta": {
      if (state === null) return state;
      const existing = state.blocks.get(inner.index);
      if (existing === undefined) return state;
      const block: LiveBlock = { ...existing };
      const delta = inner.delta;
      switch (delta.type) {
        case "text_delta":
          block.text += delta.text;
          break;
        case "thinking_delta":
          block.text += delta.thinking;
          break;
        case "signature_delta":
          // Opaque signature — nothing to display.
          return state;
        case "input_json_delta":
          block.partialJson += delta.partial_json;
          break;
      }
      const blocks = new Map(state.blocks);
      blocks.set(inner.index, block);
      return { ...state, blocks };
    }
    case "content_block_stop":
      // No-op for display: the `assistant` event is the finalizer, not this.
      return state;
    case "message_delta":
      return state;
    case "message_stop": {
      if (state === null) return state;
      return { ...state, done: true };
    }
    default:
      return state;
  }
}

/**
 * Reconcile a consolidated `assistant` event against the live state. When the
 * event's `message.id` matches the live message, advance `committedCount` so
 * the just-committed block stops being drawn from the live view. When the
 * message is fully committed AND done, discard the live state entirely.
 */
export function finalizeForAssistant(state: LiveState, event: AssistantEvent): LiveState {
  if (state === null) return state;
  if (event.message.id !== state.id) return state;

  const committedCount = state.committedCount + 1;

  // Fully drained: every started block committed and the message stopped.
  if (state.done && committedCount >= state.blocks.size) {
    return null;
  }
  return { ...state, committedCount };
}

/** Blocks still awaiting their consolidated `assistant` event, index-ascending. */
export function inFlightBlocks(state: LiveState): LiveBlock[] {
  if (state === null) return [];
  return [...state.blocks.values()]
    .filter((b) => b.index >= state.committedCount)
    .sort((a, b) => a.index - b.index);
}

function seedBlock(index: number, content: ContentBlock): LiveBlock | null {
  switch (content.type) {
    case "text":
      return { index, type: "text", text: "", partialJson: "" };
    case "thinking":
      return { index, type: "thinking", text: "", partialJson: "" };
    case "tool_use":
      return { index, type: "tool_use", text: "", toolName: content.name, partialJson: "" };
    default:
      // tool_result and unmodeled block types don't stream as live previews.
      return null;
  }
}
