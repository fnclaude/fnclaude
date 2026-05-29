/**
 * MCP tool descriptions + JSON-Schema input shapes for the four fnclaude
 * tools exposed by the §7.5 subprocess.
 *
 * Ported verbatim from the Go canonical
 * (`/home/tom/src/fnclaude@fnrhombus/src/mcp.go` — `toolRestart`,
 * `toolSwitchProject`, `toolSpawnSession`, `toolCopyToClipboard`). Schemas
 * here drive the `tools/list` MCP response that claude reads at session
 * start, so the model knows what each tool does and which arguments it
 * accepts; mismatches versus the canonical Go strings would silently
 * regress prompt UX. Keep these aligned with Go until both implementations
 * converge on a single spec source.
 *
 * The shape is plain JSON-Schema (`type: "object"` + `properties` +
 * `required`). `createJsonRpcServer`'s `tools/list` rendering preserves
 * this object verbatim, so any tightening (additional validators, formats,
 * defaults) just lands here.
 */

import type { McpToolName } from './dispatch.ts';

export interface McpToolSchema {
  description: string;
  inputSchema: object;
}

const RESTART: McpToolSchema = {
  description:
    "Restart the current fnclaude session in place, preserving conversation context. Use when the user asks to restart their session. fnclaude preserves the user's original startup flags (--ide, --brief, --allowedTools, etc.); the optional override args below let you change individual flags for the restarted session when the user requests it. Args: session_id (the current Claude session ID — read it from your shell env as $CLAUDE_CODE_SESSION_ID via Bash, since the env var isn't exposed to MCP tool input directly). Optional overrides: model, effort, permission_mode, allowed_tools, agent, brief, chrome, ide, verbose.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'The current Claude session ID. Read the value of $CLAUDE_CODE_SESSION_ID from your shell env via Bash and pass it verbatim.',
      },
      model: {
        type: 'string',
        description:
          'Optional. The model alias to use for the restarted session (e.g. opus, sonnet, haiku). --model is slash-command-mutable but has no env exposure; pass it only when the user explicitly requested a model change for this restart. Omit to preserve the startup --model (or its bare-magic equivalent).',
      },
      effort: {
        type: 'string',
        description:
          "Optional. The current in-session effort level. Read `$CLAUDE_EFFORT` via Bash before calling — claude updates this env var on `/effort` slash commands, and the assistant's Bash subprocess sees the live value. Pass it verbatim. Omit if unset; fnclaude will preserve the startup --effort if any.",
      },
      permission_mode: {
        type: 'string',
        description:
          "Optional. Override the permission mode. fnclaude auto-captures the live mode from this session's JSONL log, so omit unless the user explicitly requested a change for this restart.",
      },
      allowed_tools: {
        type: 'string',
        description:
          'Optional. Override --allowedTools (immutable per session; preservation from startup is the only fallback).',
      },
      agent: {
        type: 'string',
        description: 'Optional. Override --agent (immutable per session).',
      },
      brief: {
        type: 'boolean',
        description:
          'Optional. true → ensure --brief is on; false → off; omit → preserve startup.',
      },
      chrome: {
        type: 'boolean',
        description:
          'Optional. true → ensure --chrome is on; false → off; omit → preserve startup.',
      },
      ide: {
        type: 'boolean',
        description:
          'Optional. true → ensure --ide is on; false → off; omit → preserve startup.',
      },
      verbose: {
        type: 'boolean',
        description:
          'Optional. true → ensure --verbose is on; false → off; omit → preserve startup.',
      },
    },
    required: ['session_id'],
  },
};

const SWITCH_PROJECT: McpToolSchema = {
  description:
    'Switch this fnclaude session to a different project, carrying a continuity summary. ONE-SHOT: call once and the session is killed and re-launched at the destination. Because the call ends this session, print a brief cancellation-window line to the user (e.g. "Transferring in 3 seconds. Ctrl-C to cancel.") and run a Bash sleep BEFORE calling this tool; if the sleep completes uninterrupted, call once. fnclaude preserves the user\'s startup flags (minus a denylist of destination-bound ones like --add-dir, --mcp-config, --from-pr, --name, etc.); the optional override args below replace individual flags. Args: destination (verbatim user reference: a short repo name like \'arch-setup\', a name@owner like \'arch-setup@fnrhombus\', an owner/name like \'fnrhombus/arch-setup\', a URL, or an absolute path; a +workspace suffix is supported for worktrees), name (a 3-6 word kebab-case session topic, e.g. \'fix-auth-bug\'), summary (a /compact-style continuity summary that lets the receiving session pick up where this one left off — what the user asked for, decisions made, files touched, work in flight, open questions, user-specific observations), session_id (the current session UUID, read from $CLAUDE_CODE_SESSION_ID; used by fnclaude to auto-capture the live permission-mode from this session\'s JSONL log). Optional overrides: model, effort, permission_mode, allowed_tools, agent, brief, chrome, ide, verbose. Response.action will be done (transfer in flight), paste_flow (auto-handoff disabled — copy/paste the rendered command), or error.',
  inputSchema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description: 'Verbatim user reference to the destination project.',
      },
      name: { type: 'string', description: 'A 3-6 word kebab-case session topic.' },
      summary: {
        type: 'string',
        description: 'A /compact-style continuity summary.',
      },
      session_id: {
        type: 'string',
        description:
          'Optional. The current Claude session ID (read $CLAUDE_CODE_SESSION_ID via Bash). Used by fnclaude to auto-capture live permission-mode from the session JSONL when no explicit override is set.',
      },
      model: {
        type: 'string',
        description:
          'Optional. Override --model. Slash-command-mutable but has no env exposure; pass only when the user explicitly requested a change. Omit to preserve startup --model.',
      },
      effort: {
        type: 'string',
        description:
          "Optional. The current in-session effort level. Read `$CLAUDE_EFFORT` via Bash before calling — claude updates this env var on `/effort` slash commands, and the assistant's Bash subprocess sees the live value. Pass it verbatim. Omit if unset; fnclaude will preserve the startup --effort if any.",
      },
      permission_mode: {
        type: 'string',
        description:
          "Optional. Override the permission mode. fnclaude auto-captures the live mode from this session's JSONL log, so omit unless the user explicitly requested a change for this transfer.",
      },
      allowed_tools: {
        type: 'string',
        description: 'Optional. Override --allowedTools.',
      },
      agent: { type: 'string', description: 'Optional. Override --agent.' },
      brief: {
        type: 'boolean',
        description:
          'Optional. true → ensure --brief on; false → off; omit → preserve startup.',
      },
      chrome: {
        type: 'boolean',
        description:
          'Optional. true → ensure --chrome on; false → off; omit → preserve startup.',
      },
      ide: {
        type: 'boolean',
        description:
          'Optional. true → ensure --ide on; false → off; omit → preserve startup.',
      },
      verbose: {
        type: 'boolean',
        description:
          'Optional. true → ensure --verbose on; false → off; omit → preserve startup.',
      },
    },
    required: ['destination', 'name', 'summary'],
  },
};

const SPAWN_SESSION: McpToolSchema = {
  description:
    "Spawn a sibling fnclaude session for a different project in a new terminal window, while leaving the CURRENT session running. Use when, in the middle of a task here, the user discovers an unrelated task in another project but doesn't want to abandon what's happening in this session. (Use fnc_switch_project instead when the current session should be replaced.) ONE-SHOT: call once; no countdown or cancellation window is needed — the current session keeps running regardless. Spawn is a fresh start — it does NOT preserve this session's startup flags; pass the optional override args when the user wants the sibling to start with explicit tooling choices. Args: destination (verbatim user reference: short repo name, name@owner, owner/name, URL, or absolute path; +workspace suffix supported), name (3-6 word kebab-case session topic for the new session, e.g. 'fix-css-bug'), summary (a /compact-style continuity summary for the new session — what the user wants done in that other project, with enough context to start cold). Optional overrides (applied to the sibling, not this session): model, effort, permission_mode, allowed_tools, agent, brief, chrome, ide, verbose. Response.action will be done (sibling launched), paste_flow (no launcher available — copy/paste the rendered command into a new terminal), or error.",
  inputSchema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description:
          'Verbatim user reference to the destination project for the sibling session.',
      },
      name: {
        type: 'string',
        description: 'A 3-6 word kebab-case session topic for the sibling session.',
      },
      summary: {
        type: 'string',
        description:
          "A /compact-style continuity summary scoped to the sibling session's task.",
      },
      model: {
        type: 'string',
        description: 'Optional. --model for the sibling (e.g. opus, sonnet, haiku).',
      },
      effort: {
        type: 'string',
        description:
          'Optional. --effort for the sibling (low, medium, high, xhigh, max). For the *current* session\'s live effort, read `$CLAUDE_EFFORT` via Bash.',
      },
      permission_mode: {
        type: 'string',
        description: 'Optional. --permission-mode for the sibling.',
      },
      allowed_tools: {
        type: 'string',
        description: 'Optional. --allowedTools for the sibling.',
      },
      agent: {
        type: 'string',
        description: 'Optional. --agent for the sibling.',
      },
      brief: {
        type: 'boolean',
        description: 'Optional. true → start sibling with --brief; false / omit → no --brief.',
      },
      chrome: {
        type: 'boolean',
        description: 'Optional. true → start sibling with --chrome.',
      },
      ide: {
        type: 'boolean',
        description: 'Optional. true → start sibling with --ide.',
      },
      verbose: {
        type: 'boolean',
        description: 'Optional. true → start sibling with --verbose.',
      },
    },
    required: ['destination', 'name', 'summary'],
  },
};

const COPY_TO_CLIPBOARD: McpToolSchema = {
  description:
    "Copy text to the user's clipboard. Args: text. Useful for paste-flow handoffs when auto-switching is disabled.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text to copy to the clipboard.',
      },
    },
    required: ['text'],
  },
};

const REQUEST_COMPACT: McpToolSchema = {
  description:
    "Compact the current conversation in place by triggering claude's /compact slash command, optionally with custom instructions. Use when the user asks to compact, or when you judge the context is getting long and want to summarize before continuing. Fire-and-forget: the command is queued into the live session and runs as if the user typed it; you do NOT receive the compaction summary back through this tool. Args: instructions (optional free-text guidance passed to /compact, e.g. 'focus on the auth refactor, drop the unrelated debugging'), follow_up (optional — a prompt to submit automatically AFTER the compaction completes, so the session resumes work without waiting for the user; provide it when you want to continue a task across the compaction boundary).",
  inputSchema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description: 'Optional free-text guidance appended to /compact.',
      },
      follow_up: {
        type: 'string',
        description:
          'Optional prompt submitted as a normal user turn after the compaction completes, to auto-resume work.',
      },
    },
  },
};

const SET_EFFORT: McpToolSchema = {
  description:
    "Change the current session's reasoning effort level in place via claude's /effort slash command. Use when the user asks to raise or lower effort. Fire-and-forget: the command is queued into the live session as if typed; no output is returned. Args: effort (one of low, medium, high, xhigh, max, auto).",
  inputSchema: {
    type: 'object',
    properties: {
      effort: {
        type: 'string',
        description: 'The effort level: low, medium, high, xhigh, max, or auto.',
        enum: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
      },
    },
    required: ['effort'],
  },
};

const SET_MODEL: McpToolSchema = {
  description:
    "Change the current session's model in place via claude's /model slash command. Use when the user asks to switch models. Fire-and-forget: the command is queued into the live session as if typed; no output is returned. Args: model (one of opus, sonnet, haiku).",
  inputSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: 'The model alias: opus, sonnet, or haiku.',
        enum: ['opus', 'sonnet', 'haiku'],
      },
    },
    required: ['model'],
  },
};

const RUN_SLASH_COMMAND: McpToolSchema = {
  description:
    "Run an arbitrary claude slash command in the current session by injecting it into the live TUI input. Generic escape hatch for slash commands that don't have a dedicated fnc tool. Fire-and-forget: the command is queued as if typed by the user; you do NOT receive its output back. Args: command (the slash command name, with or without a leading slash, e.g. 'clear' or '/clear'), args (optional array of arguments appended after the command).",
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The slash command name, with or without a leading slash.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional positional arguments appended after the command.',
      },
    },
    required: ['command'],
  },
};

export const TOOL_SCHEMAS: Record<McpToolName, McpToolSchema> = {
  fnc_restart: RESTART,
  fnc_switch_project: SWITCH_PROJECT,
  fnc_spawn_session: SPAWN_SESSION,
  fnc_copy_to_clipboard: COPY_TO_CLIPBOARD,
  request_compact: REQUEST_COMPACT,
  fnc_set_effort: SET_EFFORT,
  fnc_set_model: SET_MODEL,
  fnc_run_slash_command: RUN_SLASH_COMMAND,
};
