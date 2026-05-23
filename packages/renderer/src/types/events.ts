/**
 * Stream-json event types emitted by:
 *   claude --print --verbose --input-format stream-json --output-format stream-json
 *
 * See docs/stream-json-findings.md for provenance and docs/event-spec.md for
 * the slice-level contract.
 */

export type ClaudeEvent = SystemEvent | AssistantEvent | UserEvent | ResultEvent | RateLimitEvent;

export interface SystemEvent {
  type: "system";
  subtype: "init" | (string & {});
  session_id: string;
  uuid: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  slash_commands?: string[];
  permissionMode?: string;
  memory_paths?: string[];
  claude_code_version?: string;
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
  | "errors";

export interface FilterState {
  preset: Preset;
  overrides: Partial<Record<ElementId, Visibility>>;
}
