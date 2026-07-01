/**
 * Stream-json event types emitted by:
 *   claude --print --verbose --input-format stream-json --output-format stream-json
 *
 * See docs/stream-json-findings.md for provenance and docs/event-spec.md for
 * the slice-level contract.
 */

export type ClaudeEvent =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | RateLimitEvent
  | StreamEvent
  | ParseErrorEvent
  | UserPromptEvent;

/**
 * Synthetic event for a prompt the user typed and submitted in the renderer.
 * claude does NOT echo user turns back over stream-json, so without this the
 * transcript would show only assistant replies. The renderer appends one of
 * these on Enter to keep the conversation legible. Not a wire type — the
 * `type` discriminator is namespaced so it can't collide with a real event.
 */
export interface UserPromptEvent {
  type: "user_prompt";
  text: string;
}

/**
 * Synthetic event the parser emits for a line it could not `JSON.parse`.
 * Surfaces corruption instead of silently dropping it (the renderer shows it
 * as a dim raw block). Not a wire type — the `type` discriminator is namespaced
 * so it can never collide with a real claude event.
 */
export interface ParseErrorEvent {
  type: "parse_error";
  raw: string;
}

export interface SystemEvent {
  type: "system";
  subtype: "init" | "status" | (string & {});
  session_id: string;
  uuid: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  slash_commands?: string[];
  permissionMode?: string;
  memory_paths?: string[];
  claude_code_version?: string;
  /** Present on subtype "status" — e.g. "requesting" between turns. */
  status?: string;
}

export interface AssistantEvent {
  type: "assistant";
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
  request_id?: string;
  message: AssistantMessage;
}

export interface AssistantMessage {
  id?: string;
  model: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: TokenUsage;
}

export interface UserEvent {
  type: "user";
  session_id: string;
  uuid?: string;
  message: UserMessage;
}

export interface UserMessage {
  role: "user";
  content: ContentBlock[] | string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | TextBlock[];
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error" | (string & {});
  is_error: boolean;
  session_id: string;
  uuid: string;
  result: string;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, TokenUsage>;
  stop_reason?: string | null;
  terminal_reason?: string;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  session_id?: string;
  rate_limit_info?: Record<string, unknown>;
}

/**
 * Partial-message envelope — emitted only with `--include-partial-messages`.
 * `event` is the verbatim Anthropic Messages-API streaming SSE event. These
 * lines interleave between the consolidated events; the consolidated
 * `assistant` event remains the source of truth (see
 * docs/stream-json-findings.md). The renderer uses these purely for a live
 * in-progress preview that is dropped when the matching `assistant` lands.
 */
export interface StreamEvent {
  type: "stream_event";
  event: StreamInner;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
  /** Present on the `message_start` inner event only. */
  ttft_ms?: number;
}

export type StreamInner =
  | { type: "message_start"; message: AssistantMessage }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: BlockDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null; stop_sequence: string | null };
      usage?: TokenUsage;
    }
  | { type: "message_stop" };

export type BlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Input event: what the renderer writes to claude's stdin as a user turn.
 * Emit as one JSON object per line, `\n` terminated.
 */
export interface UserTurn {
  type: "user";
  message: {
    role: "user";
    content: [{ type: "text"; text: string }];
  };
}

/**
 * Filter state types (see docs/filter-state-spec.md).
 */
export type Preset = "quiet" | "normal" | "verbose" | "debug";

export type Visibility = "show" | "hide" | "summary" | "dim";

export type ElementId =
  | "thinking"
  | "Bash.input"
  | "Bash.output"
  | "Edit.diff"
  | "Read.content"
  | "Write.content"
  | "Task.nested"
  /**
   * The generic structured fallback for any tool without a bespoke view
   * (Grep, Glob, WebFetch, TodoWrite, every MCP tool). A SINGLE shared id
   * rather than one-per-tool: the tool set is open-ended and the Alt+digit
   * table is full. Leans on `summary` in quiet/normal, `show` in
   * verbose/debug. Toggle with Alt+g.
   */
  | "tool.generic"
  | "errors"
  /**
   * System/JSON noise: the session-init header, non-init/status `system`
   * events (e.g. thinking_tokens), and rate-limit events. Hidden in
   * quiet/normal/verbose; shown only in `debug`. Toggle with Alt+m.
   */
  | "meta"
  /**
   * Per-turn token-usage one-liner (the Alt+u POC). Hidden in
   * quiet/normal/verbose; shown only in `debug`. Toggle with Alt+u.
   */
  | "token-burn";

export interface FilterState {
  preset: Preset;
  overrides: Partial<Record<ElementId, Visibility>>;
}
