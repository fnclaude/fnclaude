/**
 * Top-level Ink component. Owns:
 *
 * - the in-memory event log (`ClaudeEvent[]`, append-only per session)
 * - the filter state (`FilterState`)
 * - input handling (Alt+1-8, Alt+0/9, Ctrl+L/D/C, typed text + Enter)
 * - status surface (preset, override count, momentary toast)
 *
 * Filter applies at render time (see docs/filter-state-spec.md), so a
 * toggle re-renders the whole transcript from the log through the new
 * filter — Ink reconciles the screen diff.
 *
 * The live `ClaudeSubscription` is now CREATED by `mountRenderer` and
 * INJECTED via the `subscription` prop (docs/design.renderer.md §7) — App no
 * longer self-subscribes. The subscription exposes `.events` (the async
 * iterable), `.sendUserTurn(text)`, and `.close()`; App consumes `.events`
 * and drives turns, but the OWNER (mountRenderer/fnc) owns lifecycle, so App
 * never calls `.close()` on unmount.
 * Per-element renderers are imported from `./renderers/` (slice C;
 * stubbed locally until that slice merges).
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClaudeSubscription } from "./claude-process.ts";
import {
  cyclePreset,
  defaultState,
  overrideCount,
  resolve,
  toggleElement,
} from "./filter-state.ts";
import { type Key, dispatchKey } from "./keybinds.ts";
import {
  type LiveState,
  emptyLive,
  finalizeForAssistant,
  inFlightBlocks,
  liveReducer,
} from "./live-message.ts";
import {
  ErrorRenderer,
  type GlowRunner,
  RawJson,
  ResultRenderer,
  SystemInit,
  TextRenderer,
  ThinkingRenderer,
  ToolResultRenderer,
  ToolUseRenderer,
} from "./renderers/index.ts";
import type {
  AssistantEvent,
  ClaudeEvent,
  ElementId,
  FilterState,
  RateLimitEvent,
  ResultEvent,
  SystemEvent,
  UserEvent,
  Visibility,
} from "./types/events.ts";

/**
 * A streaming feed: an injectable source of events for tests. Receives an
 * emitter (`push` one event, `close` the stream) and returns a teardown fn.
 * Production never passes this — it subscribes to claude directly. Tests use
 * it to drive event arrival deterministically without a subprocess.
 */
export type StreamFeed = (emit: {
  push: (event: ClaudeEvent) => void;
  close: () => void;
}) => () => void;

const TOAST_DURATION_MS = 2000;

export interface AppProps {
  /**
   * Live claude subscription, created and owned by `mountRenderer` (§7). When
   * present, App consumes `subscription.events` and routes input through its
   * `sendUserTurn`. When `undefined`, App is in static/test mode: it renders
   * `initialEvents` (or a `streamFeed`) with no live stream. App never closes
   * the subscription — the handle/fnc owns its lifecycle.
   */
  subscription?: ClaudeSubscription;
  /**
   * Seed the event log. Can be combined with a live `subscription` (e.g. seed
   * a resumed transcript, then stream new events). On its own (no
   * subscription, no streamFeed) it's the static render path tests use.
   */
  initialEvents?: ClaudeEvent[];
  /**
   * Test hook: an injectable event source for the token-streaming tests.
   * Used only in static/test mode (no live `subscription`); App ingests from
   * this feed so a test can push `stream_event`/`assistant`/… events one at a
   * time to exercise the live streaming reducer without a subprocess.
   */
  streamFeed?: StreamFeed;
  /**
   * Glow runner for committed assistant text. Omitted → the module default
   * (detect + run glow). Tests pass a spy to assert glow is run for committed
   * text but never for the raw live preview.
   */
  glow?: GlowRunner | null;
  /**
   * Test hook: receives the same handler `useInput` registers, so a test
   * can drive input deterministically without a TTY. Production code
   * never passes this — Ink wires real stdin.
   */
  testInputBus?: (handler: (input: string, key: Key) => void) => void;
}

interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

function AssistantRender({
  event,
  visibilityFor,
  glow,
}: {
  event: AssistantEvent;
  visibilityFor: (id: ElementId) => Visibility;
  glow?: GlowRunner | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {event.message.content.map((block, idx) => {
        const k = `${event.uuid}-${idx}`;
        if (block.type === "text") {
          return glow === undefined ? (
            <TextRenderer key={k} text={block.text} />
          ) : (
            <TextRenderer key={k} text={block.text} glow={glow} />
          );
        }
        if (block.type === "thinking") {
          return (
            <ThinkingRenderer
              key={k}
              thinking={block.thinking}
              visibility={visibilityFor("thinking")}
            />
          );
        }
        if (block.type === "tool_use") {
          return <ToolUseRenderer key={k} block={block} visibilityFor={visibilityFor} />;
        }
        return null;
      })}
    </Box>
  );
}

function UserRender({
  event,
  toolCallById,
  visibilityFor,
}: {
  event: UserEvent;
  toolCallById: Map<string, ToolCallInfo>;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement {
  const content = event.message.content;
  if (typeof content === "string") {
    return <Text>{content}</Text>;
  }
  return (
    <Box flexDirection="column">
      {content.map((block, idx) => {
        const k = `${event.uuid ?? "user"}-${idx}`;
        if (block.type === "text") {
          return <Text key={k}>{block.text}</Text>;
        }
        if (block.type === "tool_result") {
          const call = toolCallById.get(block.tool_use_id);
          return (
            <ToolResultRenderer
              key={k}
              block={block}
              toolName={call?.name ?? ""}
              {...(call?.input ? { toolInput: call.input } : {})}
              visibilityFor={visibilityFor}
            />
          );
        }
        return null;
      })}
    </Box>
  );
}

function ResultRender({
  event,
  suppressBody,
}: {
  event: ResultEvent;
  /**
   * When the result text duplicates the final assistant text block, the body
   * is already on screen — render a compact terminator instead of re-printing.
   */
  suppressBody?: boolean;
}): React.ReactElement | null {
  if (event.is_error) {
    return <ErrorRenderer message={event.result} />;
  }
  if (suppressBody) {
    // The answer is already rendered (glow'd) via AssistantRender; emit nothing
    // for the duplicated body. A future PR can surface result metadata here.
    return null;
  }
  return <ResultRenderer event={event} />;
}

function SystemRender({ event }: { event: SystemEvent }): React.ReactElement {
  if (event.subtype === "init") {
    return <SystemInit event={event} />;
  }
  if (event.subtype === "status") {
    return <Text dimColor>{`◌ ${event.status ?? "working"}…`}</Text>;
  }
  // Any other system subtype (compact_boundary, can_use_tool, error, …):
  // surface raw rather than drop.
  return <RawJson value={event} label={`system/${event.subtype}`} />;
}

function RateLimitRender({ event }: { event: RateLimitEvent }): React.ReactElement {
  return <RawJson value={event.rate_limit_info ?? {}} label="rate_limit" />;
}

export function App(props: AppProps): React.ReactElement {
  const { subscription, initialEvents, streamFeed, glow, testInputBus } = props;
  const [events, setEvents] = useState<ClaudeEvent[]>(() => initialEvents ?? []);
  // Transient token-streaming state: an in-progress assistant message built
  // from `stream_event` deltas, rendered below the committed transcript and
  // self-clearing as each block's consolidated `assistant` event lands.
  const [live, setLive] = useState<LiveState>(emptyLive);
  const [filter, setFilter] = useState<FilterState>(defaultState);
  const [draft, setDraft] = useState<string>("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subRef = useRef<ClaudeSubscription | null>(null);

  // Single ingest point for any event source. `stream_event` lines drive the
  // transient live reducer; `assistant` events finalize the matching live
  // block then append; everything else appends unchanged. Keeping the
  // committed-event path byte-for-byte identical isolates all streaming
  // complexity in the additive `live` surface.
  const ingest = useMemo(
    () => (event: ClaudeEvent) => {
      if (event.type === "stream_event") {
        setLive((prev) => liveReducer(prev, event));
        return;
      }
      if (event.type === "assistant") {
        setLive((prev) => finalizeForAssistant(prev, event));
      }
      setEvents((prev) => [...prev, event]);
    },
    [],
  );

  // Consume the injected live subscription (production / fnc). The
  // subscription is created and OWNED by mountRenderer — App reads its
  // `.events` and stores it in `subRef` for input dispatch, but does NOT
  // close it on unmount: lifecycle belongs to the handle/fnc (spawn-args §c).
  useEffect(() => {
    if (subscription === undefined) return;
    subRef.current = subscription;
    let cancelled = false;
    (async () => {
      for await (const event of subscription.events) {
        if (cancelled) break;
        ingest(event);
      }
    })();
    return () => {
      cancelled = true;
      // Intentionally NO subscription.close() here — the owner (mountRenderer
      // /fnc) closes it via the handle. The closeStdin keybind still sends EOF.
      subRef.current = null;
    };
  }, [subscription, ingest]);

  // Test-only injectable feed for token-streaming tests (no subprocess). When
  // a live `subscription` is present this is skipped — production never sets
  // both.
  useEffect(() => {
    if (subscription !== undefined) return;
    if (streamFeed === undefined) return;
    return streamFeed({ push: ingest, close: () => undefined });
  }, [subscription, streamFeed, ingest]);

  // Build a tool_use_id → { name, input } index for tool_result dispatch.
  // Re-derived from the log on every render; cheap, log is in-memory.
  // Slice C's ToolResultRenderer needs the original `input` for results
  // that summarize against the call (e.g. Read.content's file_path).
  const toolCallById = useMemo(() => {
    const m = new Map<string, ToolCallInfo>();
    for (const event of events) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "tool_use") {
            m.set(block.id, { name: block.name, input: block.input });
          }
        }
      }
    }
    return m;
  }, [events]);

  const visibilityFor = useMemo(() => (id: ElementId) => resolve(id, filter), [filter]);

  const flashToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  };

  // Cleanup the toast timer on unmount.
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    };
  }, []);

  const handleKey = (input: string, key: Key) => {
    const action = dispatchKey(input, key);
    if (action !== null) {
      switch (action.kind) {
        case "toggleElement":
          setFilter((f) => toggleElement(f, action.element));
          flashToast(`toggled ${action.element}`);
          return;
        case "cyclePreset":
          setFilter((f) => cyclePreset(f, action.direction));
          flashToast(action.direction === 1 ? "preset cycled forward" : "preset cycled backward");
          return;
        case "repaint":
          // Force a no-op state update to trigger a fresh paint. The
          // event log already lives in state, so React's reconciler
          // walks it again on any state change.
          setFilter((f) => ({ ...f }));
          flashToast("repaint");
          return;
        case "closeStdin":
          subRef.current?.close().catch(() => undefined);
          flashToast("close stdin");
          return;
        case "interrupt":
          flashToast("interrupt");
          return;
      }
      return;
    }
    // Text input: typed chars go into the draft; Enter submits.
    if (key.return) {
      if (draft.length > 0) {
        subRef.current?.sendUserTurn(draft);
        setDraft("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    // Ignore control/meta-only inputs that didn't match a bind.
    if (key.ctrl || key.meta) return;
    if (input.length > 0) {
      setDraft((d) => d + input);
    }
  };

  // Production: register the handler with Ink. Tests: expose it via
  // testInputBus instead so they don't need real stdin.
  //
  // `handleKey` closes over draft/filter state but reads them via
  // setState callbacks where it matters — passing it through a ref
  // avoids re-running the testInputBus effect on every render while
  // still letting the test observe the latest closure.
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  useInput((input, key) => handleKeyRef.current(input, key as unknown as Key), {
    isActive: testInputBus === undefined,
  });
  useEffect(() => {
    if (testInputBus !== undefined) {
      testInputBus((input, key) => handleKeyRef.current(input, key));
    }
  }, [testInputBus]);

  const statusLine = (() => {
    const n = overrideCount(filter);
    const parts = [`preset: ${filter.preset}`];
    if (n > 0) parts.push(`${n} override${n === 1 ? "" : "s"}`);
    if (toast !== null) parts.push(toast);
    return parts.join("  |  ");
  })();

  // Duplicate-answer guard: claude's `result.result` is a verbatim copy of the
  // final assistant text block, and both render → the answer prints twice.
  // The last assistant text block is the canonical, glow-rendered copy, so a
  // `result` whose text matches it is shown as a terminator only, not re-printed.
  const lastAssistantText = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === "assistant") {
        const textBlock = ev.message.content.find((b) => b.type === "text");
        return textBlock?.type === "text" ? textBlock.text : null;
      }
    }
    return null;
  }, [events]);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {events.map((event, idx) => {
          const key = "uuid" in event && event.uuid ? event.uuid : `${event.type}-${idx}`;
          if (event.type === "assistant") {
            return (
              <AssistantRender
                key={key}
                event={event}
                visibilityFor={visibilityFor}
                {...(glow !== undefined ? { glow } : {})}
              />
            );
          }
          if (event.type === "user") {
            return (
              <UserRender
                key={key}
                event={event}
                toolCallById={toolCallById}
                visibilityFor={visibilityFor}
              />
            );
          }
          if (event.type === "result") {
            const dup = !event.is_error && event.result === lastAssistantText;
            return <ResultRender key={key} event={event} suppressBody={dup} />;
          }
          if (event.type === "system") {
            return <SystemRender key={key} event={event} />;
          }
          if (event.type === "rate_limit_event") {
            return <RateLimitRender key={key} event={event} />;
          }
          if (event.type === "parse_error") {
            return <RawJson key={key} value={event.raw} label="parse_error" />;
          }
          // Any unmodeled top-level event (image/document/error/compact_boundary
          // /…): surface raw rather than silently drop.
          return <RawJson key={key} value={event} label="event" />;
        })}
      </Box>
      <LiveRegion live={live} visibilityFor={visibilityFor} />
      {draft.length > 0 ? (
        <Text>{`> ${draft}`}</Text>
      ) : (
        <Text>
          {"> "}
          <Text dimColor>type a message and press Enter</Text>
        </Text>
      )}
      <Text>{statusLine}</Text>
    </Box>
  );
}

/**
 * The transient token-streaming preview, rendered below the committed
 * transcript. Only in-flight blocks (not yet finalized by their `assistant`
 * event) are drawn. Text/thinking previews render RAW (glow disabled) — running
 * glow per-delta is slow and mangles partial markdown; the finalized
 * `assistant` text gets glow one frame later. tool_use shows a dim placeholder
 * because `partialJson` is invalid until the last chunk (never parsed mid-stream).
 */
function LiveRegion({
  live,
  visibilityFor,
}: {
  live: LiveState;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement | null {
  const blocks = inFlightBlocks(live);
  if (blocks.length === 0) return null;
  return (
    <Box flexDirection="column">
      {blocks.map((b) => {
        const k = `live-${b.index}`;
        if (b.type === "text") {
          return <TextRenderer key={k} text={b.text} glow={null} />;
        }
        if (b.type === "thinking") {
          if (b.text.length === 0) return null;
          return (
            <ThinkingRenderer key={k} thinking={b.text} visibility={visibilityFor("thinking")} />
          );
        }
        // tool_use: minimal dim placeholder; the real ToolUseRenderer renders
        // from the consolidated `assistant` event one frame later.
        return <Text key={k} dimColor>{`▸ ${b.toolName ?? "tool"}…`}</Text>;
      })}
    </Box>
  );
}
