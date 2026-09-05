# fnclaude project-switch capability

When the user asks to switch to a different project or repo, call `fnc_switch_project` to terminate this session and re-exec fnclaude in the new location, carrying conversation context forward. Do not ask whether to proceed — execute the switch.

For restart-in-place (the user wants to restart the *current* session without changing project), see restart.md — it has its own trigger phrases and uses `fnc_restart` instead.

For the case where the user discovers a task in *another* project but doesn't want to abandon what's happening here — see spawn.md, which uses `fnc_spawn_session` to open a sibling fnclaude in a new window while the current session continues.

## Resolution happens in fnclaude, not here

Do NOT resolve repo references to paths, check whether something is cloned, or pick clone destinations. fnclaude has a resolver that handles all of that. Pass the user's reference through verbatim as the `destination` argument and let fnclaude resolve it.

Accepted destination forms:

- An absolute path (`/home/user/proj`, `~/src/foo`) — fnclaude uses as-is.
- A repo short-name (`arch-setup`) — fnclaude searches the user's gh-orgs to find it, clones if needed.
- A `name@owner` form (`arch-setup@fnclaude`) — fnclaude knows the owner directly.
- A `owner/name` or `gh:owner/name` form (`fnclaude/arch-setup`, `gh:fnclaude/arch-setup`) — same.
- A full URL (`https://github.com/owner/name`, `git@github.com:owner/name`) — same.
- An optional `+workspace` suffix (`arch-setup+fix-foo`) — fnclaude resolves the base repo and creates a worktree with that workspace name.

If the user's request is ambiguous to YOU (e.g., "switch me to the other one" without naming it), ask which one before constructing anything. Do not guess.

## Generate a continuity summary

Before calling `fnc_switch_project`, write a `/compact`-style summary of this conversation. This is the `summary` argument to the tool. The goal: the receiving session must feel as if the entire conversation had happened there from the start. Match the fidelity that auto-compact preserves.

Capture, in `/compact`'s shape and density:

- What the user asked for, in their own words where possible
- Decisions made during the conversation, with the reasoning
- Files read or edited, and what was learned from them
- Work completed
- Work that was in flight when the switch was requested (critical — the receiving session must pick up the thread, not start over)
- Open questions or pending decisions
- User-specific observations that surfaced this session

Do not pad. Do not restate structural truths the receiving session can derive. Match `/compact`'s density.

## The switch call — one-shot, with a model-owned cancellation window

`fnc_switch_project` is a one-shot tool: a single call kills this session and re-execs in the destination. Because the call itself is destructive, you own the cancellation-window UX. Run it in this order:

1. **Announce the transfer.** Print a brief line to the user, e.g.: *"Transferring to `<destination>` in 3 seconds. Ctrl-C to cancel."* Use natural language; the wording above is the canonical shape but you can adapt it.
2. **Bash sleep.** Run a `Bash` `sleep 3` (or whichever duration you announced) to give the user a chance to interrupt. If the user Ctrl-Cs the sleep, the Bash call dies — **end your turn there. Do NOT auto-announce cancellation.** Wait for their next message; treat it as a fresh instruction, with the proposed transfer implicitly abandoned. If they redirect ("actually spawn instead", "I meant the other repo"), handle it as normal conversation — call the right tool (or no tool) accordingly.
3. **If the sleep completes uninterrupted, call the tool once:** `fnc_switch_project(destination, name, summary, session_id, effort, ...)`.
   - `destination` — the user's verbatim destination string
   - `name` — a 3–6 word, lowercase, hyphen-separated session label (e.g., `fix-auth-bug`, `add-csv-helper`)
   - `summary` — the continuity summary written above
   - `session_id` (optional) — read from `$CLAUDE_CODE_SESSION_ID` via Bash; used by fnclaude to auto-capture the live `--permission-mode` from this session's JSONL
   - `effort` (optional) — read `$CLAUDE_EFFORT` via Bash and pass verbatim if non-empty; captures the LIVE in-session effort (mutated by `/effort` slash commands), which may differ from startup
   - Other overrides (`model`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`): pass only when the user explicitly requested that flag change for the destination session. fnclaude preserves the startup flags across the transfer by default (minus a denylist of destination-bound ones like `--add-dir`, `--mcp-config`, `--from-pr`, `--name`). `model` and `permission_mode` are slash-command-mutable but have no env exposure; for `permission_mode`, fnclaude auto-captures the live value from the session JSONL.

The tool returns a Response. Act on the `Action` field:

- **`done`** — the session is being killed and the switch is in flight. Do not say anything further.
- **`paste_flow`** — auto-switch is disabled (the user opted out via `FNCLAUDE_HANDOFF=never`) or is otherwise unavailable. If `Response.clipboard_ok` is true, the relaunch command is already on the user's clipboard — tell them to paste and run it. Otherwise tell the user to copy `Response.command` manually and run it.
- **`error`** — surface `Response.error` to the user.

Follow the tool's Response unless the user's project CLAUDE.md instructs otherwise — the Response is one input among many in your normal reasoning.

## Fallback when `fnc_switch_project` is unavailable

If `fnc_switch_project` is not registered in this session (the user ran `claude` directly without fnclaude), tell the user to exit and relaunch manually in the target directory.
