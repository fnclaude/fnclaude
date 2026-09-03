---
title: Tool reference
description: Every MCP tool fnclaude exposes to the Claude Code session it launches.
---

fnclaude runs an MCP server alongside each session and injects it via `--mcp-config`,
so the model sees these tools from session start. The descriptions below mirror what
the model is told.

## fnc_switch_project

Switch this fnclaude session to a different project, carrying a continuity summary.
One-shot: call it once and the session is killed and re-launched at the destination.
Because the call ends the session, the model prints a brief cancellation-window line
and sleeps before calling, so you can interrupt.

Startup flags are preserved, minus a denylist of destination-bound ones such as
`--add-dir`, `--mcp-config`, `--from-pr`, and `--name`.

| Argument | Required | Meaning |
| --- | --- | --- |
| `destination` | yes | The verbatim user reference: short repo name, `name@owner`, `owner/name`, a URL, or an absolute path. A `+workspace` suffix is supported. |
| `name` | yes | A 3-6 word kebab-case session topic, e.g. `fix-auth-bug`. |
| `summary` | yes | A `/compact`-style continuity summary for the receiving session. |
| `session_id` | no | The current session UUID, read from `$CLAUDE_CODE_SESSION_ID`. Lets fnclaude auto-capture the live permission mode from the session log. |
| overrides | no | `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`. |

The response `action` is `done` (transfer in flight), `paste_flow` (auto-handoff
disabled, so copy and paste the rendered command), or `error`.

## fnc_spawn_session

Spawn a sibling fnclaude session for a different project in a new terminal window,
while leaving the current session running. For when you discover an unrelated task
mid-flow and do not want to abandon this one.

One-shot, with no countdown needed — the current session keeps running regardless.
A spawn is a fresh start and does **not** preserve this session's startup flags.

| Argument | Required | Meaning |
| --- | --- | --- |
| `destination` | yes | Same reference forms as a switch. |
| `name` | yes | A 3-6 word kebab-case topic for the sibling. |
| `summary` | yes | A `/compact`-style summary scoped to the sibling's task. |
| overrides | no | Same set as a switch, applied to the sibling rather than this session. |

Response `action` is `done`, `paste_flow` (no launcher available), or `error`.

## fnc_restart

Restart the current fnclaude session in place, preserving conversation context. The
user's original startup flags are preserved; the optional overrides change individual
flags for the restarted session.

| Argument | Required | Meaning |
| --- | --- | --- |
| `session_id` | yes | The current Claude session ID, read from `$CLAUDE_CODE_SESSION_ID` via Bash. The variable is not exposed to MCP tool input directly. |
| overrides | no | `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`. |

## get_usage

Returns current budget headroom for the session: per-model cost and token breakdown,
current context-window size, and subscription limits. Meant for high-token decision
points — a subagent fan-out, a large read, deep exploration — not for polling.

Takes `session_id`, read from `$CLAUDE_CODE_SESSION_ID`. The response shape is:

```json
{
  "session": {
    "cost_usd": 0,
    "by_model": {
      "<model-id>": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "cost": 0 }
    }
  },
  "limits": null,
  "context": { "used": 0, "model": "<model-id>" }
}
```

:::caution
`limits` is `null` in this version. The rate-limit headers carrying the 5-hour,
weekly, and per-model quotas travel over claude's own API connection, not the terminal
fnclaude wraps, so live limits are not observable yet. Treat `null` as "not yet
observed", never as "no limit" or zero.
:::

`context.used` is the latest assistant turn's context size in tokens, or `null` if no
assistant turn has happened yet.

## fnc_set_model

Change the session's model in place via claude's `/model` slash command. Fire-and-forget:
the command is queued into the live session as if typed, and no output is returned.

Takes `model`, one of `opus`, `sonnet`, `haiku`.

## fnc_set_effort

Change the session's reasoning effort in place via claude's `/effort` slash command.
Fire-and-forget, same as above.

Takes `effort`, one of `low`, `medium`, `high`, `xhigh`, `max`, `auto`.

## request_compact

Compact the conversation in place by triggering claude's `/compact`, optionally with
custom instructions. Fire-and-forget: the summary does not come back through the tool.

The model is told to **drain first** — finish every queued prompt before calling,
since prompts not yet processed are lost from the compaction summary.

| Argument | Required | Meaning |
| --- | --- | --- |
| `instructions` | no | Short *additional* steering, e.g. "focus on the auth refactor, drop the unrelated debugging". `/compact` writes the summary itself, so this is not where a summary goes. |
| `follow_up` | no | A prompt submitted as a normal user message after compaction completes, so work resumes without waiting for you. Being a normal message, an `@/path/to/file.md` reference works here. |

## fnc_copy_to_clipboard

Copy text to your clipboard. Takes `text`. Mainly useful for paste-flow handoffs, when
auto-switching is disabled and the model needs to hand you a command.

## fnc_run_slash_command

Run an arbitrary claude slash command by injecting it into the live TUI input. The
generic escape hatch for slash commands with no dedicated fnc tool. Fire-and-forget.

| Argument | Required | Meaning |
| --- | --- | --- |
| `command` | yes | The slash command name, with or without a leading slash. |
| `args` | no | Positional arguments appended after the command. |

:::note
This one is opt-in. It is registered only when `FNC_ENABLE_SLASH_TOOL=1` is set in the
environment; without it the tool is omitted from the tool list entirely.
:::
