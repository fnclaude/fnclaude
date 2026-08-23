# Renderer surface options

**Status: exploration. Nothing here is decided.** Captured 2026-08-22 so the
reasoning survives the session that produced it.

The question: `packages/renderer` has been through several iterations and still
isn't converging on something good. Is the TUI the right surface at all, and if
it is, what has to be built?

---

## Why the current path is hard

Not a framework mistake. Claude Code's TUI is Ink too — it forked the rendering
layer and wrote ~660 KB of terminal code that stock Ink does not have: an
escape-sequence stack, a screen manager, frame-level paint control, mouse
hit-testing, text selection, a render optimizer. Full evidence and file
inventory in
[`../reverse-engineering/claude-code-ink-fork.md`](../reverse-engineering/claude-code-ink-fork.md).

So "make the Ink renderer good" is not a bug-fixing exercise. It is a decision to
fork Ink and own a terminal layer indefinitely. That may still be the right call
— but it should be made deliberately rather than arrived at one bug at a time.

The one exception worth separating out: **flicker**. Frame-level synchronized
output (DEC private mode 2026) is isolatable from everything else on that list,
and is already specced in `RENDERER-TODO.md` pending a go-ahead. It should not be
held hostage to this larger decision.

---

## Surface options

### A. Stock Ink (status quo)

Reach is maximal — SSH with no client install, Linux VT, tmux detach/reattach,
containers and cloud dev boxes, locked-down machines, instant start, `npm i -g`
as the whole install story.

Ceiling is low. Images, real scroll, selection and mouse are structurally out of
reach; the deferred items in `RENDERER-TODO.md` are deferred *because* of this.

### B. Forked Ink

Same reach as A, ceiling raised to Claude Code's. Cost is the fork: a terminal
escape stack, screen manager, layout wrapper, hit-testing, selection — built and
maintained against emulator variance, forever.

### C. Electron

Every hard rendering problem is solved by the platform: layout, text
measurement, bidi, selection, hit-testing, scroll virtualization, images,
typography, diffs, one rendering target instead of N emulators.

Loses everything in A's reach paragraph. Adds a permanent distribution tax —
three platform builds, macOS notarization, Windows signing, auto-update
infrastructure, ~100 MB artifacts, and two versioned channels (CLI and app).

### D. Local web UI served by fnc — the option that takes most of both

`fnc` serves HTTP + websocket and prints a URL. Same React and same
main-process architecture as C, but:

- **SSH works with no client install**: `ssh -L 8080:localhost:8080 host`, open a
  local browser. The Jupyter / code-server pattern.
- **Containers and Codespaces work** — port forwarding is native there.
- **No distribution tax.** Ships inside the CLI that's already published.
- **`npm i -g` stays the whole install story**, which keeps the positioning
  terminal-native rather than desktop-app.
- **Electron remains free later** — it would just load the local URL.

Doesn't cover a bare VT with no browser reachable anywhere. That case is already
served by PTY mode.

### Cross-cutting note

PTY mode is not part of this trade. It ships today and covers the
terminal-native case regardless of which renderer surface is chosen. The real
risk in picking C or D is not losing terminal support — it is **PTY mode
silently becoming a frozen baseline** while new work lands only on the new
surface. That's a drift failure, and it should be an explicit decision: is PTY a
supported peer, or a compatibility mode?

---

## Drive model

Independent of surface: how does the renderer talk to `claude`?

### Streaming (current, shipped)

`claude -p --input-format stream-json --output-format stream-json` is a
long-lived process. Messages in on stdin, events out on stdout, and **claude owns
conversation state and the JSONL**. `claude-process.ts` and `event-parser.ts`
already do this.

### One-shot with owned transcript

One `claude -p` invocation per user turn, full transcript resent each time.
Claude still runs the whole agentic loop internally, and
`--output-format stream-json` still yields incremental events.

**Gains — all of them shaped like deleted code:**

The renderer's transcript becomes the single source of truth rather than a
mirror of claude's JSONL. That removes an entire class of problems already
encountered: session pinning, encoded-cwd path construction, oldest-mtime
heuristics, watermark re-arm races, synthetic-zero-token guards. All of that
machinery exists only because fnc reads state it does not own.

**Costs:**

- **Compaction becomes ours.** Owning the transcript means owning context
  management — strategy, trigger, what survives. Claude Code's compact prompts
  are documented in
  [`../reverse-engineering/claude-code-compact-prompts.md`](../reverse-engineering/claude-code-compact-prompts.md).
- **Prefix-cache stability becomes an operational discipline.** The cache is
  content-keyed and server-side, so a byte-identical prefix resent inside the TTL
  still hits — one-shot does *not* inherently break caching. But any prefix
  instability (a timestamp, a reordered tool list, a varying system-prompt
  fragment) silently costs 10× with no error. Anthropic engineers around exactly
  this: the attribution block is emitted with a null cache scope so its
  per-request-varying version suffix can't invalidate the cached system prompt.
- **Billing exposure.** The headless/SDK entrypoint billing split — announced
  then paused 2026-06-15, see
  [`../reverse-engineering/claude-code-binary-internals.md`](../reverse-engineering/claude-code-binary-internals.md)
  — lands hardest on a one-shot design. Re-check its current state before
  committing.

### Steering under one-shot

Observed behavior in the TUI: a prompt sent mid-run never preempts the in-flight
step; it lands at a step boundary. Those boundaries are **inside** a single
claude invocation, so a one-shot design has no hook for them — naive queueing
degrades from "next step" to "after the entire run."

**Kill-splice-resume recovers it, at finer granularity than the TUI has:**

1. SIGINT the process mid-run.
2. Append the stream-json events already received to the transcript.
3. Synthesize a `tool_result` for any `tool_use` left unmatched by the kill —
   otherwise the next request is malformed. Claude Code does this too; its
   component tree includes an `InterruptedByUser` component and it emits a
   `[Request interrupted by user]` marker.
4. Append the steering message and re-invoke.

Cost behavior, which is what makes this viable:

- Killing skips **every remaining loop step** — the dominant saving on a long
  run, not the output tail of one request.
- Within an in-flight request, input is billed at send time; only output is
  saved by disconnecting.
- Killing **while a local tool executes is free** — that's between API calls.
- The re-invoke's prefix was just processed, so inside the cache TTL it's a
  0.1× read; the synthetic tool result lands at the suffix and doesn't disturb it.

**Unverified assumption:** that client disconnect actually aborts server-side
generation rather than an intermediary buffering while the origin keeps
producing. Standard behavior, but load-bearing for the cost model and someone
else's infrastructure. Testable by running a long generation twice, killing one
early, and diffing `rate_limits.five_hour.used_percentage` from the status-line
payload.

Two things kill-splice-resume does not recover: mid-run permission prompts (the
process is gone by the time you'd answer), and work lost to a kill landing inside
a long single tool call.

---

## Open decisions

1. Which surface — A, B, C, or D.
2. Is PTY mode a supported peer or a compatibility mode?
3. Ship the flicker fix now, independent of the above? (Currently blocked on a
   go-ahead only.)
4. Streaming or one-shot drive model.
5. If a GUI surface: does it own only its own sessions, or see the whole fleet?
   Fleet visibility needs a **local session registry** — and if that registry is
   a unix socket rather than a state directory, SSH remote support is close to
   free (`ssh -L /local.sock:/remote.sock`). If it's a directory of files, it is
   not tunnelable and would need rebuilding later. Worth deciding before it's
   built, not after.
