# fnclaude session restart — execute on sight, do not ask

**These phrases are unambiguous triggers. When the user types any of them, do NOT ask the user to clarify. Do NOT present alternatives. Do NOT propose other interpretations. Call `fnc_restart` immediately.**

Trigger phrases (case-insensitive, match exact wording or close variants):

- "restart yourself"
- "restart claude"
- "restart this session"
- "claude restart"
- "restart" — when the user does not name a different project/repo (if they DO name one, that's a project-switch instead; see project-switch.md)

These override the *WHEN-IN-DOUBT — DISCUSS* default. The phrases are themselves the user's explicit authorization to restart.

## The restart action

Call `fnc_restart` with a `session_id` argument and (optionally) `effort`.

Before the call, fetch both values from your shell env via Bash — fnclaude can't read them itself because the MCP subprocess's env was snapshotted at launch and goes stale after slash-command mutations:

```sh
echo "$CLAUDE_CODE_SESSION_ID"
echo "$CLAUDE_EFFORT"
```

Pass `CLAUDE_CODE_SESSION_ID` verbatim as `session_id` (a standard UUID, 8-4-4-4-12 hex). Claude Code does not expose this to the MCP tool input directly.

Pass `CLAUDE_EFFORT` verbatim as `effort` if it's non-empty — this captures the LIVE in-session effort level (claude updates this env var on `/effort` slash commands), which may differ from the startup `--effort`. Omit when unset; fnclaude will preserve the startup `--effort` if any.

## Other override args (when the user explicitly asks for a change)

fnclaude preserves the user's original startup flags across the restart by default. The other override args (`model`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`) are only needed when the user has explicitly asked for that flag to change for the restarted session. Don't pass them speculatively — omitting them is the right answer most of the time.

Notes:

- `model` and `permission_mode` are slash-command-mutable but have no env exposure — there's no way to read their live values. Pass only when the user explicitly requested a change. For `permission_mode` specifically, fnclaude also auto-captures the live mode from this session's JSONL log; the override is for when the user wants a different mode for the restart.
- `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose` are immutable per session — preservation from startup is the only fallback path. Pass the override only when the user is changing the flag for the restart.

The tool returns a Response with an `Action` field. Act on it:

- **`done`** — the restart is happening. The current session is being terminated and re-exec'd. Do not say anything further.
- **Any other action** — relay `Response.message` to the user as-is; it contains human-readable guidance about what happened.

## Fallback when `fnc_restart` is unavailable

If the `fnc_restart` tool is not registered in this session (the user ran `claude` directly without fnclaude), tell the user to exit and relaunch manually.

## Restart vs. project-switch

If the user names a different destination (a repo, a path, a different worktree), it is a project-switch — write a summary and call `fnc_switch_project`. If they say a restart trigger with no destination, it is restart-in-place — call `fnc_restart`, no summary needed.
