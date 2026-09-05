# fnclaude spawn-session capability

When, in the course of the current conversation, the user surfaces a task that belongs in a *different* project but the **current session still has work to do**, call `fnc_spawn_session` to open a sibling fnclaude in a new terminal window. The current session keeps running; the new window picks up the side task cold, from the continuity summary you wrote.

This is the parallel-track counterpart to `fnc_switch_project`. The difference:

- **`fnc_switch_project`** — the current session is replaced. Use when the user wants to *move* to the new project.
- **`fnc_spawn_session`** — the current session continues; a sibling opens elsewhere. Use when the user wants to *also* work on the new project without losing the thread of this one.

If the user's intent is ambiguous between "switch me there" and "open it alongside this one," ask before constructing anything. The default tilt: if their phrasing is "let's also…" / "open up a session for…" / "spawn / spin up / fire off / kick off a session for…" / any other "also-do-this" framing — that's spawn. If it's "let's go work on…" / "switch over to…" / "move me to…" / "head over to…" — that's switch.

## Resolution happens in fnclaude, not here

Pass the user's destination reference through verbatim. fnclaude resolves it. Accepted forms:

- An absolute path (`/home/user/proj`, `~/src/foo`).
- A repo short-name (`arch-setup`) — fnclaude searches gh-orgs, clones if needed.
- A `name@owner` form (`arch-setup@fnclaude`).
- A `owner/name` or `gh:owner/name` form.
- A full URL (`https://github.com/owner/name`, `git@github.com:owner/name`).
- An optional `+workspace` suffix (`arch-setup+fix-foo`) — base repo + worktree.

If the destination is ambiguous to YOU (e.g., "spawn one for the other repo" without naming it), ask which one before constructing anything.

## Generate a continuity summary scoped to the sibling's task

Before calling `fnc_spawn_session`, write a `/compact`-style summary of what the **sibling session** needs to do — not a recap of the whole current conversation. The sibling needs to start cold and immediately know what task it's there for.

Capture, in `/compact`'s shape and density:

- What the user wants done in that other project, in their own words where possible
- Any context from the current conversation that makes the task make sense (the *why*, the chain of reasoning that surfaced it)
- Files / commits / errors / docs already named that the sibling will need
- Open questions the sibling should resolve before acting
- User-specific observations from this session that the sibling should know

Do not pad. Do not re-summarize unrelated parts of the current conversation. Match `/compact`'s density.

## The spawn call — one-shot, no countdown

Call `fnc_spawn_session(destination, name, summary, ...)` once:

- `destination` — the user's verbatim destination string
- `name` — a 3–6 word, lowercase, hyphen-separated session label for the *sibling* session (e.g., `fix-css-bug`, `bump-go-version`)
- `summary` — the continuity summary written above
- Optional overrides (`model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`): pass when the user wants the sibling to start with explicit tooling choices. **Spawn does NOT preserve the current session's startup flags** — each override is independent of this session and only takes effect if explicitly passed.

There is **no cancellation window** for spawn — the current session keeps running regardless, so there's nothing to give the user a chance to abort. Call the tool directly when the user has asked for a sibling.

The tool returns a Response. Act on the `Action` field:

- **`done`** — the sibling has been launched in a new window. **Your current session continues** — relay the `Response.message` (typically "Spawned sibling fnclaude for …") to the user briefly, then resume what you were doing before the spawn request. Do NOT treat this as a session-ending event.
- **`paste_flow`** — auto-spawn isn't available (either `FNCLAUDE_HANDOFF=never` or no launcher could be resolved for this terminal). If `Response.clipboard_ok` is true, the relaunch command is already on the user's clipboard — tell them to paste it into a new terminal window. Otherwise tell them to copy `Response.command` manually and run it in a new window.
- **`error`** — surface `Response.error` to the user.

If the user wants to swap direction mid-flow (e.g., "actually switch me there instead") that's just normal conversation — call `fnc_switch_project` with the same args. There's no special protocol semantic for it; handle the redirect the same way you handle any other change of plan.

Follow the tool's Response unless the user's project CLAUDE.md instructs otherwise — the Response is one input among many in your normal reasoning.

## Fallback when `fnc_spawn_session` is unavailable

If `fnc_spawn_session` is not registered in this session (the user ran `claude` directly without fnclaude), tell the user to open a new terminal window manually and start fnclaude there.
