/**
 * Per-event render dispatch, extracted from App.tsx (issue #296 finding 3).
 *
 * Pure event→ReactNode mapping: each committed {@link ClaudeEvent} (and the
 * in-flight live preview) is turned into an Ink node here, with NO App state —
 * the only inputs are the event and a small context (`visibilityFor`, the
 * tool-call index, the last assistant text for the duplicate-answer guard).
 * App owns the event log, scroll, and input; this module owns "what does one
 * event look like".
 */

import { Box, Text } from "ink";
import { type LiveState, inFlightBlocks } from "../live-message.ts";
import { useRendererTheme } from "../theme.tsx";
import type {
  AssistantEvent,
  ClaudeEvent,
  ElementId,
  RateLimitEvent,
  ResultEvent,
  SystemEvent,
  UserEvent,
  Visibility,
} from "../types/events.ts";
import { TokenBurn } from "./TokenBurn.tsx";
import {
  ErrorRenderer,
  MarkdownRenderer,
  RawJson,
  ResultRenderer,
  SystemInit,
  ThinkingRenderer,
  ToolResultRenderer,
  ToolUseRenderer,
} from "./index.ts";

export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

/** Context threaded into every per-event renderer. Pure inputs, no App state. */
export interface RenderContext {
  visibilityFor: (id: ElementId) => Visibility;
  toolCallById: Map<string, ToolCallInfo>;
  lastAssistantText: string | null;
}

/**
 * Meta elements — the session-init header, non-init/status `system` events, and
 * rate-limit events — are hidden unless the meta filter is showing. One gate for
 * the rule-of-three (issue #296 finding 5) instead of three hand-copied checks.
 */
function metaHidden(visibilityFor: (id: ElementId) => Visibility): boolean {
  return visibilityFor("meta") === "hide";
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
  const theme = useRendererTheme();
  return (
    <Box marginTop={1} marginBottom={1} flexDirection="row">
      <Text bold color={theme.promptMarker}>
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
    if (metaHidden(visibilityFor)) return null;
    return <SystemInit event={event} />;
  }
  if (event.subtype === "status") {
    return <Text dimColor>{`◌ ${event.status ?? "working"}…`}</Text>;
  }
  // Any other system subtype (thinking_tokens, compact_boundary, error, …) is
  // raw JSON noise — gated behind the meta filter rather than always shown.
  if (metaHidden(visibilityFor)) return null;
  return <RawJson value={event} label={`system/${event.subtype}`} />;
}

function RateLimitRender({
  event,
  visibilityFor,
}: {
  event: RateLimitEvent;
  visibilityFor: (id: ElementId) => Visibility;
}): React.ReactElement | null {
  if (metaHidden(visibilityFor)) return null;
  return <RawJson value={event.rate_limit_info ?? {}} label="rate_limit" />;
}

/**
 * Exhaustiveness sink for {@link renderEventNode}. The parameter is typed
 * `never`, so adding a new {@link ClaudeEvent} variant without a matching `case`
 * is a COMPILE error here (issue #296 finding 4). At runtime an off-union
 * payload still surfaces as raw rather than being silently dropped.
 */
function renderUnknownEvent(event: never): React.ReactElement {
  return <RawJson value={event} label="event" />;
}

/**
 * Maps a single committed event to its renderer node. Exhaustive `switch` over
 * `event.type` — matches liveReducer's style and makes a new union variant a
 * compile error rather than a silent drop.
 */
export function renderEventNode(event: ClaudeEvent, ctx: RenderContext): React.ReactElement | null {
  const { visibilityFor, toolCallById, lastAssistantText } = ctx;
  switch (event.type) {
    case "assistant":
      return <AssistantRender event={event} visibilityFor={visibilityFor} />;
    case "user_prompt":
      return <UserPromptRender text={event.text} />;
    case "user":
      return <UserRender event={event} toolCallById={toolCallById} visibilityFor={visibilityFor} />;
    case "result": {
      const dup = !event.is_error && event.result === lastAssistantText;
      return <ResultRender event={event} suppressBody={dup} />;
    }
    case "system":
      return <SystemRender event={event} visibilityFor={visibilityFor} />;
    case "rate_limit_event":
      return <RateLimitRender event={event} visibilityFor={visibilityFor} />;
    case "parse_error":
      return <RawJson value={event.raw} label="parse_error" />;
    case "stream_event":
      // Consumed by the live reducer and never appended to the committed log;
      // surface raw defensively rather than dropping if one ever lands here.
      return <RawJson value={event} label="stream_event" />;
    default:
      return renderUnknownEvent(event);
  }
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
export function LiveRegion({
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
