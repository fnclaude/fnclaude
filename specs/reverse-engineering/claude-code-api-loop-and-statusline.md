# Claude Code: the Anthropic API turn loop and the statusLine lifecycle

How Claude Code drives the Anthropic Messages API across a multi-message
"the assistant is replying to itself" sequence, and how the `statusLine`
command process fits around that loop — its spawn model, render cadence,
concurrency relationship to the API turn, timeout, and kill behavior.

Written against **v2.1.218** of the Bun-compiled ELF at
`~/.local/share/mise/installs/node/<ver>/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
(273 MB, JS embedded as text). Findings were pulled with the
`LC_ALL=C grep -aboF '<needle>'` + byte-offset window technique documented in
[`claude-code-binary-internals.md`](claude-code-binary-internals.md).

> **Minified symbol names (`W5s`, `sFo`, `Zm`, `HXi`, …) are build-specific and
> will not match other versions.** They are quoted here because the wiring
> between them is the evidence. Re-anchor on the durable string literals — the
> `/v1/messages` path, the SSE `event:`/`data:` shapes, `stop_reason` values,
> `"Command timed out after …"`, `require("child_process")` — not the offsets.

> **Cross-references — do not duplicate.**
> [`claude-code-terminal-tricks.md`](claude-code-terminal-tricks.md) §"Rate-limit
> data flow and the statusLine contract" documents the **stdin JSON payload
> schema** the statusLine command receives (`rate_limits`, `context_window`,
> etc.); this doc covers the **process lifecycle** around it, not the payload
> fields.
> [`claude-code-control-protocol.md`](claude-code-control-protocol.md) covers the
> `control_request`/`control_response` NDJSON channel between an SDK parent and
> `claude --print` — a **different layer** from the CLI↔Anthropic-API loop
> described here. [`claude-code-prompt-strings.md`](claude-code-prompt-strings.md)
> holds the extracted `stop_reason` API-reference vocabulary; this doc is the
> client-side loop that consumes it.

---

## TL;DR

1. **Each visible assistant message is a separate HTTP request** to
   `POST /v1/messages`. Within one request the response is **SSE-streamed**
   (tokens arrive incrementally over a single HTTP response). Across messages
   it is a **classic agentic loop**: `stop_reason: "tool_use"` → run tools
   locally → append `tool_result` → **next request**; `stop_reason: "end_turn"`
   (or `"stop_sequence"`) ends the loop. Not websockets, not long-poll.
2. **The statusLine command is a fresh child process per render** —
   `child_process.spawn` of `sh -c "<command>"`, session JSON on stdin, stdout
   captured and pushed into React (Ink) state. Stateless: new process, new UUID
   each time.
3. **The statusLine runs beside the API turn and nothing upstream awaits it.**
   The render is a fire-and-forget React effect. Data flows one way:
   API turn → app state → statusLine render. The statusLine can never block or
   delay the API request or the transcript the user sees.
4. **The statusLine timeout is 600 000 ms (10 minutes)** — the shared default
   hook timeout, and **not** configurable from the `statusLine` settings block.
   On timeout the child's **process group gets SIGTERM, then SIGKILL after a
   1500 ms grace**. A timed-out/failed render **blanks** the status text; only a
   *superseded* render (aborted by the next one) keeps the previous frame.
   The user's ~1.5–4 s script is nowhere near the 10-minute ceiling.

---

## Q1 — One streaming HTTP request per turn, chained by `stop_reason`

Two distinct mechanisms, deliberately separated:

### (a) SSE streaming *within* a single turn

The SDK issues the request and asks for a stream:

```js
// Messages resource, create():
return this._client.post("/v1/messages", {
  body: e,
  timeout: n ?? 600000,      // non-streaming fallback timeout (10 min)
  ...t,
  headers: _s([r, t?.headers]),
  stream: e.stream ?? !1      // Claude Code sets stream:true for the turn
});
```

A stream reducer folds the SSE event sequence into one accumulating message
object `r`. The durable anchor is the event vocabulary and the `message_delta`
→ `message_stop` handling:

```js
switch (t.type) {
  case "message_stop":
    return r;                              // stream complete → return the message
  case "message_delta":
    r.stop_reason   = t.delta.stop_reason; // stop_reason arrives on message_delta
    r.stop_sequence = t.delta.stop_sequence;
    r.usage.output_tokens = t.usage.output_tokens;
    // …usage/context accumulation…
}
```

The bundle even embeds the wire format in an API-reference doc block:

```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}
event: message_stop
data: {"type":"message_stop"}
```

So one assistant message = one HTTP response, streamed token-by-token.
`timeout: n ?? 600000` is the HTTP request timeout; `n` is recomputed per-model
via `calculateNonstreamingTimeout(max_tokens, …)` only for **non-streaming**
requests — a streaming turn keeps the client's configured timeout, falling back
to 600 000 ms.

### (b) A new request *per* turn, driven by `stop_reason`

The main conversation loop is an async generator. Each iteration requests
`/v1/messages`, accumulates the assistant message `_r`, `yield`s it, and then
**branches on `_r.message.stop_reason`** to decide whether to loop again. When a
tool call is present it runs the tool locally, appends the `tool_result`, and
sets up the next iteration's message list — the generator-state reassignment
`g = { messages: [...] }` followed by `continue` **is** the "next request":

```js
yield _r;                                   // surface the assistant message

// terminal branch — turn is done:
let Vt = _r?.message.stop_reason ?? Dt;
if ((Vt === "end_turn" || Vt === "stop_sequence") && /*…has real content…*/) {
  /* loop ends (or nudges once if the response was thinking-only) */
}

// continue branch — feed the next request with appended messages:
g = { messages: [...Ie, /* …appended tool_result / recovery message… */],
      toolUseContext: V, /* … */ };
continue;
```

That a `tool_result` must ride in a *subsequent* request (not the same one) is
enforced by the SDK's own request validator — proof the loop appends and
re-requests rather than holding one long connection open:

```js
if (i /* last msg has tool_result */) {
  if (o.some(c => c.type !== "tool_result"))
    throw Error("The last message must contain only tool_result content if any is present");
  if (!l /* previous msg had tool_use */)
    throw Error("tool_result blocks are not matching any tool_use from the previous message");
}
```

**What drives the next request:** `stop_reason: "tool_use"` with parseable tool
blocks → local tool execution → `tool_result` appended → next `POST /v1/messages`.
**What ends the loop:** `stop_reason: "end_turn"` (or `"stop_sequence"`) with
actual content. Other `stop_reason`s route to recovery branches that also
`continue` with an injected message (`"max_tokens"` → resume nudge;
`"tool_use"` with *zero* parseable blocks → malformed-tool-use retry;
thinking-only `end_turn` → a single nudge), but the shape is always the same:
append a message, fire another request.

So the "assistant replying to itself" the user sees is **N discrete streaming
HTTP requests**, one per assistant message, chained locally by `stop_reason` —
not one socket delivering many messages.

**Confidence:** confirmed. `/v1/messages` POST with `stream`, the SSE reducer
(`message_delta` → `stop_reason`, `message_stop` → return), the generator's
`stop_reason` branch + `messages:[…]` / `continue`, and the tool_result
ordering validator are all present in the bundle.

---

## Q2 — The statusLine command: a fresh child process per render

### Spawn model

`child_process` is imported directly, and the statusLine reuses the **generic
hook executor** `sFo` (the same one that runs `PreToolUse`, `PostToolUse`, etc.):

```js
oFo = require("child_process"), Tmt = require("crypto");
// …
// non-PowerShell, shell-form command:
B = oFo.spawn(L, [], { env: M, cwd: U, shell: Be, detached: W, windowsHide: !0 });
```

- `L` is the configured command string; `shell: Be` (`true` off Windows) means it
  runs as `sh -c "<command>"`.
- `detached: W` (`W = !isWindows`) puts the child in **its own process group** —
  which is what lets the timeout path signal the whole tree (see Q4).
- The stdin payload is written, then the stream closed:
  `B.stdin.write(n + "\n", "utf8"); B.stdin.end();` where `n` is the JSON payload.

The statusLine entry point `W5s` builds that payload, spawns via `sFo`, and
captures stdout:

```js
async function W5s(e, t, r = !1) {
  if (fd("statusLine")) return;                                  // feature-flag gate
  if (KKe()) { w("Skipping StatusLine command execution - workspace trust not accepted"); return }
  let n = JRt(ds()?.statusLine);                                 // read config fresh each call
  if (!n || n.type !== "command") return;                        // must be {type:"command"}
  let o = He(e),                                                  // o = JSON.stringify(payload)
      i = Date.now(),
      s = await sFo(n, "StatusLine", "statusLine", o, jIt(e), t, Tmt.randomUUID());  // spawn (awaited)
  if (s.aborted) return;
  if (s.status === 0) {
    let l = s.stdout.trim().split("\n").flatMap(c => c.trim() || []).join("\n");     // capture stdout
    if (l) return l;                                             // → becomes the status text
  }
  // …telemetry: spawn_failed / timeout / nonzero_exit…
}
```

- **Fresh process every render** — `sFo` spawns anew and `Tmt.randomUUID()`
  tags each invocation. There is no persistent statusLine daemon.
- **Session JSON on stdin** — the object built by `n_S` (`cwd`, `model`,
  `workspace`, `rate_limits`, `context_window`, `version`, …), `JSON.stringify`d
  via `He()`. Field schema: see the terminal-tricks cross-reference above.
- **stdout captured and rendered** — trimmed, blank lines dropped, returned as
  the status string. stderr is captured separately and logged, not displayed.

### Render cadence — event-driven (debounced) plus an optional timer

The renderer is a React/Ink hook. A new render is an async callback `D` that
aborts any in-flight render, snapshots state, and runs the command through the
orchestrator `t_S`, whose result updates the `statusLineText` state slice:

```js
D = wx.useCallback(async () => {
  o.current?.abort();                     // supersede any render still running
  let K = new AbortController; o.current = K;
  // …snapshot messages, model, git, prStatus, etc.…
  await t_S({
    signal: K.signal,
    executeCommand: () => W5s(n_S({ /* …snapshot… */ }), K.signal, ie),
    onResult: de => l(ae => ae.statusLineText === de ? ae
                                                     : { ...ae, statusLineText: de })
  });
}, [e, l]);

let j = tee(() => { D() }, 300);          // D is debounced to 300 ms (tee = debounce)

wx.useEffect(() => {                       // fire when messageId or any tracked field changes
  let K = { tokenUsage: r, permissionMode: i, vimMode: n, mainLoopModel: d,
            fastMode: p, effortValue: f, thinkingEnabled: m, prStatus: g };
  if (t !== L.current.messageId || Object.keys(K).some(ie => K[ie] !== L.current[ie]))
    Object.assign(L.current, K), j();
}, [t, r, i, n, d, p, f, m, g, j]);

let W = u?.refreshInterval;                // optional periodic re-render
Hc(j, W !== void 0 ? Math.max(1, W) * 1000 : null);   // useInterval; null = disabled
```

Triggers, therefore:

- **A new assistant message** (messageId `t` changes) → debounced render. This is
  the direct answer to "why does the statusline update as the assistant replies
  to itself" — each turn changes state, which schedules a render.
- **Any tracked field change** — token usage, permission mode, vim mode, model,
  fast-mode, effort, thinking, PR status.
- **A config `command` change** — separate effect, re-renders immediately.
- **An optional periodic refresh** — `refreshInterval` (whole seconds, `min(1)`)
  runs the command "every N seconds in addition to event-driven updates." Absent
  by default → no timer, purely event-driven.

All renders are debounced 300 ms, and every new render **aborts the previous
one** (`o.current?.abort()`), so bursty state changes collapse to at most one
in-flight command.

**Confidence:** confirmed. `require("child_process")`, the `spawn` options,
`W5s`/`sFo` wiring, the stdin write, the `useCallback`/`useEffect`/`tee`/`Hc`
render graph, and the `refreshInterval` schema (`b.number().min(1).optional()`,
described as "Re-run the status line command every N seconds…") are all present.

---

## Q3 — The statusLine runs *beside* the API turn; nothing awaits it

The dependency is strictly one-directional: **API turn → app state → statusLine
render.** The statusLine is a downstream observer of state; it never feeds back
into the request path.

- The render orchestrator `t_S` awaits the command, but that `await` is contained
  entirely inside the fire-and-forget effect chain:

  ```js
  async function t_S(e) {
    let { signal: t, executeCommand: r, onResult: i } = e;
    try {
      let l = await r();          // r() === W5s(...) — the spawned child
      if (t.aborted) return;      // superseded → drop the result
      if (i(l), l) { /* telemetry */ }   // else push result into React state
    } catch {}
  }
  ```

- `t_S` is awaited only by `D`; `D` is invoked by the 300 ms debounce timer
  (`tee`) and by `useEffect` callbacks. **React never awaits effect callbacks**,
  and the debounce timer discards `D`'s returned promise — so the whole chain
  floats. No caller on the API side ever holds a reference to it.

- The **API turn generator (Q1) and the statusLine render live on separate call
  stacks.** They intersect only through React state: the turn loop updates
  `messages` / `tokenUsage`; the statusLine's `useEffect` observes those updates
  and schedules a render. There is no path by which the statusLine's promise can
  gate the `/v1/messages` request or the transcript.

- **No back-pressure.** The command's stdout feeds only the `statusLineText`
  state slice — a distinct render region from the assistant transcript. A slow
  or hung command delays *only* the status-text update; it cannot stall token
  streaming, tool execution, or the next request. And because each render aborts
  the prior in-flight one, a slow command is superseded rather than queued.

**Confidence:** confirmed. `t_S`'s `await r()` is reachable only through the
debounced `useCallback` → `useEffect` graph; the request loop shares no await
edge with it.

---

## Q4 — Timeout value and kill behavior

### The value: 600 000 ms (10 minutes), and not statusLine-configurable

`sFo` computes the per-command timeout as:

```js
P = e.timeout ? e.timeout * 1000 : Zm,   // config timeout (seconds) → ms, else default
// …
Zm = 600000;                              // the one standalone Zm= binding in the bundle
```

`Zm = 600000` is the **shared default timeout for every hook** — the same
generator family (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `PermissionDenied`, …) all default their `timeoutMs` to `Zm`.
The statusLine borrows the same executor.

Crucially, the `statusLine` settings schema has **no `timeout` field**:

```js
statusLine: b.object({
  type: b.literal("command"),
  command: b.string(),
  padding: b.number().optional(),
  refreshInterval: b.number().min(1).optional()...,
  hideVimModeIndicator: b.boolean().optional()...
}).optional()
```

So `e.timeout` is always undefined on the statusLine path, and `P` is always
`Zm = 600000`. Hooks *do* expose a `timeout` field and can shorten it; the
statusLine cannot — its ceiling is fixed at 10 minutes.

### The kill: SIGTERM → 1500 ms grace → SIGKILL, on the process group

The lifecycle is managed by class `HXi` (constructed via `lno(child, signal, P, …)`).
It arms `setTimeout(#m, P)` and listens for the caller's abort signal. Both the
timeout handler and an explicit abort funnel into the private killer `#C`:

```js
// timeout handler → SIGTERM-class kill (exit-code marker Tru = 143):
static #m(e) { if (e.#p && e.#a) e.#a(e.background.bind(e)); else e.#C(Tru); }

// abort handler → kill():
#_() { if (Py(this.#u.reason) === "interrupt") return; this.kill(); }
kill() { return this.#C(); }              // default marker → sno = 137

#C(e) {
  this.#e = "killed";
  let t = this.#o?.pid;
  this.#E(e ?? sno);
  if (!t || t <= 1) return Promise.resolve();
  let r = LIt(t, "SIGTERM"),               // 1) SIGTERM
      n = new Promise(o => {
        let a = setTimeout(() => {          // 3) after LHg ms grace, if still alive:
              try { process.kill(-t, "SIGKILL") } catch {}   // SIGKILL the process GROUP (-pid)
              LIt(t, "SIGKILL").finally(o);
            }, LHg);                         // LHg = 1500
        a.unref();
        r.then(() => {                       // 2) poll liveness every DHg ms until dead
          if (Cru(t)) { clearTimeout(a); o(); return }
          let i = setInterval(() => { if (!Cru(t)) { clearTimeout(a); clearInterval(i); o() } }, DHg); // DHg = 100
        });
      });
  return n;
}
```

Constants: `Tru = 143` (128 + SIGTERM), `sno = 137` (128 + SIGKILL),
`LHg = 1500` (term→kill grace, ms), `DHg = 100` (liveness poll, ms).

Sequence on **timeout**: SIGTERM to the child's process group → poll every 100 ms
for up to 1500 ms → if still alive, `process.kill(-pid, "SIGKILL")` on the whole
group. The result carries exit code 143 and stderr
`"Command timed out after <duration>"`; W5s records
`pe("status_line_command", "timeout")`.

Sequence on **abort** (a newer render calling `abort()`): identical SIGTERM→SIGKILL,
but exit code 137 with `interrupted: true`.

### Timed-out/failed render blanks the text; only a *superseded* render keeps it

The two outcomes differ in what reaches `onResult`:

- **Superseded (aborted by the next render):** in `t_S`, `signal.aborted` is
  true, so it returns **before** calling `onResult` → `statusLineText` unchanged
  → **last frame stays on screen.**
- **Timeout / nonzero exit / empty stdout (not superseded):** `signal.aborted`
  is false, `W5s` returns `undefined`, and `t_S` calls `onResult(undefined)`
  unconditionally (`if (i(l), l)` — the `i(l)` runs regardless of `l`) →
  `statusLineText` becomes `undefined` → **the status line blanks.**

In an active session the abort/supersede path dominates: any state change inside
a slow render's window schedules a new render that aborts the old one, so you
keep the last good frame. The pure-timeout blank requires a command that hangs
for a full 10 minutes with *zero* intervening state changes — effectively a
corner case.

### The ~1.5–4 s user script: not a timeout risk

CC's statusLine ceiling is **600 000 ms**; a 4 s script uses **0.67 %** of it.
There is no realistic path to CC killing a ~4 s script on timeout — the ceiling
is ~150× its worst case, and it is not user-lowerable on the statusLine path.

The real consequences of a multi-second script are cadence, not termination:

- **Staleness:** the status text lags a triggering event by the script's runtime
  (up to ~4 s) plus the 300 ms debounce. Never blocks anything the user sees.
- **Abort churn:** when triggering events arrive closer together than the script
  runs (~4 s), each render aborts the previous mid-flight (SIGTERM→SIGKILL). The
  script's per-run cost (reported ~154 subprocesses) is then repeatedly spawned
  and killed before completing, and the status text updates rarely — it lands
  only when the script gets a clear ≳4 s window. This is wasted work and a
  laggy indicator, but it is bounded, non-blocking, and invisible to the API
  turn.

**Confidence:** confirmed. `Zm = 600000`, the timeout-free `statusLine` schema,
the `#C` SIGTERM→(1500 ms)→SIGKILL-on-process-group sequence with the 143/137
markers, and the `t_S` abort-vs-result branch are all present in the bundle.

---

## Sources

| Source | Confidence | Notes |
|---|---|---|
| Direct bundle grep, v2.1.218 Bun ELF (`bin/claude.exe`, JS-as-text) | High | Byte-offset windows via `grep -aboF` + `tail -c`/`head -c`; symbol names version-specific, durable string literals cited alongside |
| [`claude-code-terminal-tricks.md`](claude-code-terminal-tricks.md) | High | statusLine **stdin payload schema** + rate-limit flow (this doc = lifecycle, not payload) |
| [`claude-code-control-protocol.md`](claude-code-control-protocol.md) | High | The `--print` stream-json control channel — a different layer from the CLI↔Anthropic-API loop here |
| [`claude-code-prompt-strings.md`](claude-code-prompt-strings.md) | High | Extracted `stop_reason` API-reference vocabulary consumed by the Q1 loop |
| [`claude-code-binary-internals.md`](claude-code-binary-internals.md) | High | The offset/slice reverse-engineering technique used throughout |
