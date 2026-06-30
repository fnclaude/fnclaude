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

import { Box, Text, useApp, useInput, useWindowSize } from "ink";
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
import { TokenBurn } from "./renderers/TokenBurn.tsx";
import {
  ErrorRenderer,
  MarkdownRenderer,
  RawJson,
  ResultRenderer,
  SystemInit,
  ThinkingRenderer,
  ToolResultRenderer,
  ToolUseRenderer,
} from "./renderers/index.ts";
import { MeasuredRow } from "./scroll/MeasuredRow.tsx";
import { ScrollViewport } from "./scroll/ScrollViewport.tsx";
import { type AnchoredScroll, useAnchoredScroll } from "./scroll/useAnchoredScroll.ts";
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

/**
 * Rows reserved below the scroll viewport for the input control (draft line +
 * status line). The transcript viewport gets `terminalRows - CHROME_ROWS`.
 */
const CHROME_ROWS = 2;

/**
 * Idle Ctrl+C double-tap window. A single Ctrl+C while nothing is generating
 * flashes a hint; a second within this window exits. Mirrors native claude's
 * "press Ctrl+C again to exit" affordance.
 */
const CTRL_C_EXIT_WINDOW_MS = 1000;

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
   * Test hook: receives the same handler `useInput` registers, so a test
   * can drive input deterministically without a TTY. Production code
   * never passes this — Ink wires real stdin.
   */
  testInputBus?: (handler: (input: string, key: Key) => void) => void;
  /**
   * Test seam: an injectable exit. Production omits it and the idle Ctrl+C
   * double-tap routes through Ink's `useApp().exit()`. Tests pass a spy so
   * they can assert the exit path without tearing down the test renderer.
   */
  exit?: () => void;
  /**
   * Test seam: fix the scroll viewport height in rows. Production omits it and
   * the viewport is sized to `useWindowSize().rows - CHROME_ROWS`. Tests pass a
   * large value so legacy frame assertions see the full (unclipped) transcript,
   * or a small value to exercise clipping/anchoring deterministically.
   */
  viewportHeight?: number;
}

interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

function AssistantRender({
  event,
  visibilityFor,
}: {
  event: AssistantEvent;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {event.message.content.map((block, idx) => {
        const k = `${event.uuid}-${idx}`;
        if (block.type === "text") {
          return <MarkdownRenderer key={k} text={block.text} />;
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
      {event.message.usage !== undefined && visibilityFor("token-burn") !== "hide" && (
        // Per-turn token-usage one-liner (Alt+u POC). INSIDE the turn's Box so
        // its height is part of the measured row — toggling it is what proves
        // the scroll anchoring keeps visible rows put.
        <TokenBurn usage={event.message.usage} />
      )}
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

/**
 * A prompt the user typed and submitted, rendered as a native-style bar so the
 * conversation reads as a dialogue. The "› " marker mirrors Claude Code's own
 * prompt affordance.
 */
function UserPromptRender({ text }: { text: string }): React.ReactElement {
  // The body routes through MarkdownRenderer (same as assistant text) so any
  // markdown the user typed renders styled, never as raw syntax. The cyan "›"
  // marker keeps the native prompt-bar affordance; it sits in a row beside the
  // markdown block.
  return (
    <Box marginTop={1} marginBottom={1} flexDirection="row">
      <Text bold color="cyan">
        {"› "}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        <MarkdownRenderer text={text} />
      </Box>
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
    // The answer is already rendered via AssistantRender; emit nothing for the
    // duplicated body. A future PR can surface result metadata here.
    return null;
  }
  return <ResultRenderer event={event} />;
}

function SystemRender({
  event,
  visibilityFor,
}: {
  event: SystemEvent;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement | null {
  if (event.subtype === "init") {
    // The session header is meta noise — hidden unless meta is shown (debug
    // preset or Alt+m toggle).
    if (visibilityFor("meta") === "hide") return null;
    return <SystemInit event={event} />;
  }
  if (event.subtype === "status") {
    return <Text dimColor>{`◌ ${event.status ?? "working"}…`}</Text>;
  }
  // Any other system subtype (thinking_tokens, compact_boundary, error, …) is
  // raw JSON noise — gated behind the meta filter rather than always shown.
  if (visibilityFor("meta") === "hide") return null;
  return <RawJson value={event} label={`system/${event.subtype}`} />;
}

function RateLimitRender({
  event,
  visibilityFor,
}: {
  event: RateLimitEvent;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement | null {
  if (visibilityFor("meta") === "hide") return null;
  return <RawJson value={event.rate_limit_info ?? {}} label="rate_limit" />;
}

export function App(props: AppProps): React.ReactElement {
  const { subscription, initialEvents, streamFeed, testInputBus } = props;
  const [events, setEvents] = useState<ClaudeEvent[]>(() => initialEvents ?? []);
  // Whether a turn is in flight: set when a user turn is submitted or an
  // assistant turn starts, cleared on the terminal `result` event. Drives
  // Ctrl+C's behavior (interrupt the turn vs. the idle exit double-tap).
  const [busy, setBusy] = useState<boolean>(false);
  // Timestamp of the last idle Ctrl+C, for the double-tap-to-exit window.
  const lastCtrlCRef = useRef<number | null>(null);
  // Transient token-streaming state: an in-progress assistant message built
  // from `stream_event` deltas, rendered below the committed transcript and
  // self-clearing as each block's consolidated `assistant` event lands.
  const [live, setLive] = useState<LiveState>(emptyLive);
  const [filter, setFilter] = useState<FilterState>(defaultState);
  const [draft, setDraft] = useState<string>("");
  // Live mirror of `draft`. React 19's automatic batching means several
  // synchronously-dispatched keystrokes (typed char, then Enter) are
  // processed before a re-render refreshes the handler's closure — so the
  // submit/continuation paths can't read `draft` directly without seeing a
  // stale value. The ref is the source of truth updated inside the handler;
  // `setDraft` only drives the render.
  const draftRef = useRef<string>("");
  const writeDraft = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subRef = useRef<ClaudeSubscription | null>(null);

  // Shell-style prompt-history recall. `promptHistoryRef` is the oldest→newest
  // list of submitted prompts; `histIdxRef` is the cursor (== length means "on
  // the live draft, not browsing"); `histStashRef` holds the in-progress draft
  // stashed when navigation begins so Down past the newest restores it. Seeded
  // once from any resumed `user_prompt` events so recall spans the prior turns.
  const promptHistoryRef = useRef<string[]>([]);
  const seededHistoryRef = useRef(false);
  const histIdxRef = useRef(0);
  const histStashRef = useRef("");
  if (!seededHistoryRef.current) {
    seededHistoryRef.current = true;
    const seeded = (initialEvents ?? [])
      .filter((e): e is Extract<ClaudeEvent, { type: "user_prompt" }> => e.type === "user_prompt")
      .map((e) => e.text);
    promptHistoryRef.current = seeded;
    histIdxRef.current = seeded.length;
  }

  // Exit path: the injected test seam if present, else Ink's app exit.
  const inkApp = useApp();
  const exitApp = props.exit ?? (() => inkApp.exit());

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
        // An assistant turn is being produced — mark busy so Ctrl+C interrupts.
        setBusy(true);
        setLive((prev) => finalizeForAssistant(prev, event));
      }
      if (event.type === "result") {
        // Terminal event for the turn — nothing is generating anymore.
        setBusy(false);
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

  // App-owned scroll viewport. The transcript is a top-level control sized to
  // the terminal (minus the input chrome); the controller owns scroll state and
  // anchoring. Tests fix the height via `viewportHeight` for determinism.
  const windowSize = useWindowSize();
  const viewportHeight = props.viewportHeight ?? Math.max(1, windowSize.rows - CHROME_ROWS);
  const ctl = useAnchoredScroll({ viewportHeight });

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
        case "scroll":
          // Move the app-owned viewport; releases/resumes sticky-follow per the
          // controller's bottom rule.
          ctl.onScroll(action.delta);
          return;
        case "historyPrev": {
          const h = promptHistoryRef.current;
          if (h.length === 0) return;
          if (histIdxRef.current >= h.length) {
            // entering history from the live draft — stash it so Down can restore it
            histStashRef.current = draftRef.current;
            histIdxRef.current = h.length;
          }
          if (histIdxRef.current > 0) {
            histIdxRef.current -= 1;
            writeDraft(h[histIdxRef.current] ?? "");
          }
          return;
        }
        case "historyNext": {
          const h = promptHistoryRef.current;
          if (histIdxRef.current >= h.length) return; // already at the live draft
          histIdxRef.current += 1;
          writeDraft(
            histIdxRef.current >= h.length ? histStashRef.current : (h[histIdxRef.current] ?? ""),
          );
          return;
        }
        case "closeStdin":
          subRef.current?.close().catch(() => undefined);
          flashToast("close stdin");
          return;
        case "interrupt":
          if (busy) {
            // A turn is in flight: cancel it without ending the session. claude
            // aborts the current turn and stays alive for further user turns.
            subRef.current?.interrupt();
            flashToast("interrupt");
            lastCtrlCRef.current = null;
            return;
          }
          // Idle: first Ctrl+C hints, a second within the window exits — native
          // claude's double-tap-to-exit. (Easily switched to Ctrl+D-only.)
          {
            const now = Date.now();
            if (
              lastCtrlCRef.current !== null &&
              now - lastCtrlCRef.current < CTRL_C_EXIT_WINDOW_MS
            ) {
              exitApp();
              return;
            }
            lastCtrlCRef.current = now;
            flashToast("press Ctrl+C again to exit");
          }
          return;
      }
      return;
    }
    // Text input: typed chars go into the draft; Enter submits.
    if (key.return) {
      // Shift+Enter inserts a line break instead of submitting — but only
      // where the terminal sends a distinct sequence for it (many emit a bare
      // CR indistinguishable from Enter, so this silently won't fire there).
      if (key.shift) {
        writeDraft(`${draftRef.current}\n`);
        return;
      }
      // Backslash-continuation: a trailing "\" turns Enter into a newline and
      // is itself consumed. Terminal-agnostic fallback for shift+enter.
      if (draftRef.current.endsWith("\\")) {
        writeDraft(`${draftRef.current.slice(0, -1)}\n`);
        return;
      }
      if (draftRef.current.length > 0) {
        const text = draftRef.current;
        // Append the prompt to the transcript — claude never echoes user turns
        // back, so without this the submitted text would vanish.
        setEvents((prev) => [...prev, { type: "user_prompt", text }]);
        subRef.current?.sendUserTurn(text);
        // Record the prompt for history recall and reset navigation to the live
        // end: Up after a submit starts from the newest, and a fresh Down (with
        // no stash) restores an empty draft rather than a stale stashed one.
        promptHistoryRef.current = [...promptHistoryRef.current, text];
        histIdxRef.current = promptHistoryRef.current.length;
        histStashRef.current = "";
        // A turn is now in flight — Ctrl+C should interrupt, not exit.
        setBusy(true);
        writeDraft("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      writeDraft(draftRef.current.slice(0, -1));
      return;
    }
    // Ignore control/meta-only inputs that didn't match a bind. In Ink 7
    // a bare Escape sets key.escape (not key.meta), so guard it explicitly.
    if (key.ctrl || key.meta || key.escape) return;
    if (input.length > 0) {
      writeDraft(draftRef.current + input);
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
  // The last assistant text block is the canonical, markdown-rendered copy, so a
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
      {/* TRANSCRIPT — a top-level control. Wrapped in the app-owned scroll
          viewport; the input is a SEPARATE sibling below (not nested), so the
          transcript can clip independently. */}
      <Box flexDirection="column" flexGrow={1}>
        <ScrollViewport
          height={viewportHeight}
          scrollOffset={ctl.scrollOffset}
          onContentHeight={ctl.setContentHeight}
        >
          <Transcript
            events={events}
            live={live}
            visibilityFor={visibilityFor}
            ctl={ctl}
            toolCallById={toolCallById}
            lastAssistantText={lastAssistantText}
          />
        </ScrollViewport>
      </Box>
      {/* INPUT — a separate top-level control (draft + status). */}
      <Box flexDirection="column">
        {draft.length > 0 ? (
          // Indent continuation lines under the "> " prompt so a multi-line
          // draft (shift+enter / backslash-continuation) reads cleanly.
          <Text>{`> ${draft.replace(/\n/g, "\n  ")}`}</Text>
        ) : (
          <Text>
            {"> "}
            <Text dimColor>type a message and press Enter</Text>
          </Text>
        )}
        <Text>{statusLine}</Text>
      </Box>
    </Box>
  );
}

/**
 * The transcript control: maps the committed event log (plus the in-flight live
 * preview) to measured rows inside the scroll viewport. Each row is wrapped in
 * a {@link MeasuredRow} that reports its unclipped height to the controller, and
 * the render order is declared via `ctl.setOrderedIds` so the anchoring math can
 * keep visible rows put across filter toggles. Holds NO scroll state itself.
 */
function Transcript({
  events,
  live,
  visibilityFor,
  ctl,
  toolCallById,
  lastAssistantText,
}: {
  events: ClaudeEvent[];
  live: LiveState;
  visibilityFor: (id: ElementId) => Visibility;
  ctl: AnchoredScroll;
  toolCallById: Map<string, ToolCallInfo>;
  lastAssistantText: string | null;
}): React.ReactElement {
  const liveBlocks = inFlightBlocks(live);
  const hasLive = liveBlocks.length > 0;

  const rows = events.map((event, idx) => ({
    key: "uuid" in event && event.uuid ? event.uuid : `${event.type}-${idx}`,
    node: renderEventNode(event, { visibilityFor, toolCallById, lastAssistantText }),
  }));

  const orderKey = `${rows.map((r) => r.key).join(" ")}|${hasLive ? "live" : ""}`;
  const { setOrderedIds } = ctl;
  const orderedIds = hasLive ? [...rows.map((r) => r.key), "live-region"] : rows.map((r) => r.key);
  // `orderKey` is the stable serialization of `orderedIds`; depending on the
  // array directly would re-run the effect every render on new identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: orderKey encodes orderedIds
  useEffect(() => {
    setOrderedIds(orderedIds);
  }, [orderKey, setOrderedIds]);

  return (
    <>
      {rows.map((r) => (
        <MeasuredRow key={r.key} id={r.key} onHeight={ctl.reportRowHeight}>
          {r.node}
        </MeasuredRow>
      ))}
      {hasLive && (
        <MeasuredRow id="live-region" onHeight={ctl.reportRowHeight}>
          <LiveRegion live={live} visibilityFor={visibilityFor} />
        </MeasuredRow>
      )}
    </>
  );
}

/**
 * Maps a single committed event to its renderer node. Pure dispatch — extracted
 * so {@link Transcript} can wrap each in a {@link MeasuredRow} while keeping the
 * per-event branching in one place.
 */
function renderEventNode(
  event: ClaudeEvent,
  ctx: {
    visibilityFor: (id: ElementId) => Visibility;
    toolCallById: Map<string, ToolCallInfo>;
    lastAssistantText: string | null;
  },
): React.ReactElement | null {
  const { visibilityFor, toolCallById, lastAssistantText } = ctx;
  if (event.type === "assistant") {
    return <AssistantRender event={event} visibilityFor={visibilityFor} />;
  }
  if (event.type === "user_prompt") {
    return <UserPromptRender text={event.text} />;
  }
  if (event.type === "user") {
    return <UserRender event={event} toolCallById={toolCallById} visibilityFor={visibilityFor} />;
  }
  if (event.type === "result") {
    const dup = !event.is_error && event.result === lastAssistantText;
    return <ResultRender event={event} suppressBody={dup} />;
  }
  if (event.type === "system") {
    return <SystemRender event={event} visibilityFor={visibilityFor} />;
  }
  if (event.type === "rate_limit_event") {
    return <RateLimitRender event={event} visibilityFor={visibilityFor} />;
  }
  if (event.type === "parse_error") {
    return <RawJson value={event.raw} label="parse_error" />;
  }
  // Any unmodeled top-level event (image/document/error/compact_boundary/…):
  // surface raw rather than silently drop.
  return <RawJson value={event} label="event" />;
}

/**
 * The transient token-streaming preview, rendered below the committed
 * transcript. Only in-flight blocks (not yet finalized by their `assistant`
 * event) are drawn. Text previews render natively through MarkdownRenderer,
 * whose `remend` pass heals partial markdown so a per-delta render never leaks a
 * dangling `**`/fence; the finalized `assistant` text re-renders identically one
 * frame later. tool_use shows a dim placeholder because `partialJson` is invalid
 * until the last chunk (never parsed mid-stream).
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
          // remend (inside MarkdownRenderer) heals partial markdown, so the
          // per-delta preview renders natively without leaking dangling syntax.
          return <MarkdownRenderer key={k} text={b.text} />;
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
