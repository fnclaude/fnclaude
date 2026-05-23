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
 * `subscribeToClaude` is imported from `./claude-process.ts` (slice A).
 * The returned `ClaudeSubscription` exposes `.events` (the async iterable),
 * `.sendUserTurn(text)`, and `.close()`.
 * Per-element renderers are imported from `./renderers/` (slice C;
 * stubbed locally until that slice merges).
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ClaudeSubscription, subscribeToClaude } from "./claude-process.ts";
import {
  cyclePreset,
  defaultState,
  overrideCount,
  resolve,
  toggleElement,
} from "./filter-state.ts";
import { type Key, dispatchKey } from "./keybinds.ts";
import {
  ErrorRenderer,
  ResultRenderer,
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
  ResultEvent,
  UserEvent,
  Visibility,
} from "./types/events.ts";

const TOAST_DURATION_MS = 2000;

export interface AppProps {
  /**
   * Seed the event log. Omit (or pass `undefined`) to subscribe live to
   * claude via slice A's `subscribeToClaude`. Tests pass a fixed array
   * so they don't need a running subprocess.
   */
  initialEvents?: ClaudeEvent[];
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
}: {
  event: AssistantEvent;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {event.message.content.map((block, idx) => {
        const k = `${event.uuid}-${idx}`;
        if (block.type === "text") {
          return <TextRenderer key={k} text={block.text} />;
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
}: {
  event: ResultEvent;
}): React.ReactElement {
  if (event.is_error) {
    return <ErrorRenderer message={event.result} />;
  }
  return <ResultRenderer event={event} />;
}

export function App(props: AppProps): React.ReactElement {
  const { initialEvents, testInputBus } = props;
  const [events, setEvents] = useState<ClaudeEvent[]>(() => initialEvents ?? []);
  const [filter, setFilter] = useState<FilterState>(defaultState);
  const [draft, setDraft] = useState<string>("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subRef = useRef<ClaudeSubscription | null>(null);

  // Subscribe to slice A only when no initialEvents were provided — tests
  // pass a static log; production starts empty and ingests live.
  useEffect(() => {
    if (initialEvents !== undefined) return;
    let cancelled = false;
    const sub = subscribeToClaude();
    subRef.current = sub;
    (async () => {
      for await (const event of sub.events) {
        if (cancelled) break;
        setEvents((prev) => [...prev, event]);
      }
    })();
    return () => {
      cancelled = true;
      sub.close().catch(() => undefined);
      subRef.current = null;
    };
  }, [initialEvents]);

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

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {events.map((event) => {
          const key =
            "uuid" in event && event.uuid ? event.uuid : `${event.type}-${events.indexOf(event)}`;
          if (event.type === "assistant") {
            return <AssistantRender key={key} event={event} visibilityFor={visibilityFor} />;
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
            return <ResultRender key={key} event={event} />;
          }
          // system / rate_limit_event: header-only, always shown.
          if (event.type === "system") {
            return null;
          }
          return null;
        })}
      </Box>
      {draft.length > 0 ? <Text>{`> ${draft}`}</Text> : null}
      <Text>{statusLine}</Text>
    </Box>
  );
}
