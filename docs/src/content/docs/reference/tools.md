---
title: Tool reference
description: Every MCP tool fnclaude gives the Claude Code session it launches.
---

fnclaude runs an MCP server beside each session and registers it through an injected
`--mcp-config`. The model sees these tools from the first turn. The descriptions
below say what the model is told.

## fnc_switch_project

Switch this session to a different project, carrying a continuity summary. One-shot:
the session is killed and relaunched at the destination. Because the call ends the
session, the model prints a short countdown line and sleeps before calling, so you
can interrupt.

Startup flags carry over, minus a denylist of ones that belong to the old
destination: `--add-dir`, `--mcp-config`, `--from-pr`, `--name`, and similar.

| Argument | Required | Meaning |
| --- | --- | --- |
| `destination` | yes | Your reference, verbatim: a bare name, `name@owner`, `owner/name`, a URL, or an absolute path. A `+workspace` suffix works. |
| `name` | yes | A three-to-six-word kebab-case topic, such as `fix-auth-bug`. |
| `summary` | yes | A written summary of the conversation for the receiving session. |
| `session_id` | no | The current session UUID, read from `$CLAUDE_CODE_SESSION_ID`. Lets fnclaude read the live permission mode out of the session log. |
| overrides | no | `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`. |

The response `action` is `done` (transfer in flight), `paste_flow` (auto-handoff is
off, so the rendered command comes back for you to paste), or `error`.

## fnc_spawn_session

Open a sibling session for a different project in a new terminal window, and leave
this one running. For when an unrelated task turns up mid-flow and you do not want
to drop this one.

One-shot, with no countdown. This session keeps running either way. A spawn is a
fresh start and does **not** carry this session's startup flags.

| Argument | Required | Meaning |
| --- | --- | --- |
| `destination` | yes | Same forms as a switch. |
| `name` | yes | A three-to-six-word kebab-case topic for the sibling. |
| `summary` | yes | A written summary scoped to the sibling's task. |
| overrides | no | Same set as a switch, applied to the sibling. |

The response `action` is `done`, `paste_flow` (no launcher available), or `error`.

## fnc_restart

Restart this session in place, keeping the conversation. Your startup flags carry
over. The overrides change one flag at a time for the restarted session.

| Argument | Required | Meaning |
| --- | --- | --- |
| `session_id` | yes | The current session UUID. The model reads `$CLAUDE_CODE_SESSION_ID` through Bash, since MCP tool input cannot see it. |
| overrides | no | `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`. |

## get_usage

Returns what this session has spent: cost and tokens per model, the current context
size, and subscription limits. For decision points that cost a lot of tokens, such as
a subagent fan-out or a large read. Not for polling.

Takes `session_id`, read from `$CLAUDE_CODE_SESSION_ID`. The response:

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
`limits` is `null` in this version. The rate-limit headers that carry the 5-hour,
weekly, and per-model quotas travel over claude's own API connection, not the
terminal fnclaude wraps, so fnclaude cannot see them. Read `null` as "not observed",
never as "no limit" or zero.
:::

`context.used` is the context size of the latest assistant turn in tokens, or `null`
before the first one.

## fnc_copy_to_clipboard

Put text on your clipboard. Takes `text`. For when the model has something you
should paste rather than run.
