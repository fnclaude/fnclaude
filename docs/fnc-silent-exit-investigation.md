# Silent-exit bug — investigation notes

Author state: `fnclaude@1.1.1` installed via mise (`/home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/`). The TS port has been wiped from `packages/cli/src/` after these notes were written; this doc is the artifact the rewrite picks up from.

Pinning the dependent versions for the record:

- Bun: **1.3.14** (Linux x64)
- Node: **24.15.0**
- node-pty (installed CLI's `node_modules`): **1.2.0-beta.13** (the version `packages/cli/package.json` pins)
- node-pty (stale workspace `node_modules/.bun/`): **1.1.0** (hoisting artifact; not what the user actually runs)
- claude binary: **2.1.152** (Claude Code), ELF x86-64 (compiled Node.js app at `/home/tom/.local/share/mise/installs/node/24.15.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`)

User config (`~/.config/fnclaude/config.toml`):

```toml
[auto]
tmux = "worktree"
handoff = "3"
spawn_command = "uwsm app -a ghostty -- ghostty -e {bin} {dest} --name {name} @{summary}"
```

## 1. Symptom

```
$ fnc -- "say hi"
$ echo $?
0
```

No output, no claude UI, no claude subprocess started in any observable way, RC=0. Reported under tmux inside ghostty; observed reproducible outside tmux too (see §4).

Critically: this exit is **fast** (sub-second), not a timeout. claude is not launching at all from the user's perspective — but the symptom is RC=0 silence, not a visible crash.

## 2. Root-cause narrative (current best understanding)

The TS pipeline reaches `runWithPTY` correctly and invokes `node-pty`'s `spawn()` with a valid `claudeArgv`. node-pty's `forkpty` succeeds. The child is `claude`, which is an ELF (compiled Node) — and **claude exits with `signal=SIGHUP` almost immediately under Bun, before printing anything**.

The "almost immediately" qualifier matters: trivial children that exit quickly (e.g. `bash -c 'echo done; exit 42'`) survive. The SIGHUP is delivered only to children that block on a syscall (sleep, read, the event loop of a real Node app). claude blocks on its event loop while initialising — it gets SIGHUP before producing any UI.

**The Bun + node-pty interaction is the locus.** Same node-pty 1.2.0-beta.13 binary, same claude binary, same env — replace `bun` with `node` and the bug vanishes (§5.1). This is not a node-pty bug per se, it's a Bun-driving-node-pty bug.

The TS code's `runWithPTY` (in `packages/cli/src/pty/unix.ts`, lines 274–429) is *correct as written* against a normal node-pty. The Go reference (`/home/tom/src/fnclaude@fnrhombus/src/pty_run_unix.go`) does the same dance with `github.com/creack/pty` and works. Nothing the TS code does is wrong; the runtime under it is.

## 3. Confirmed observations

### 3.1 SIGHUP is the kill signal, not a fake/normal exit

```
EXIT: {"exitCode":0, "signal":1}
```

`signal: 1` is SIGHUP. The codebase already has a note (`packages/cli/src/pty/unix.ts:410–416`) calling node-pty's `signal` field "unreliable under Bun" because it's been observed as `1` on both normal exits and deliberate kills. **That note is incomplete.** In this case the signal field is *correct* — SIGHUP really is being delivered. The unreliability is in interpreting it, not in the value itself.

Proof the SIGHUP delivery is real and not a node-pty reporting artefact:

```bash
# Inside a script run via pty.spawn under Bun:
trap "echo HUP_RECEIVED; exit 77" SIGHUP
sleep 0.5
exit 33
```

Result: process exits **77**. The trap fires. SIGHUP is genuinely delivered to the child. Exit code 33 (the "no SIGHUP" path) is never reached. (See §5.2 for the full reproducer.)

### 3.2 Output emitted before the kill is delivered; output emitted by the SIGHUP trap handler is LOST

In the same script: `PID=N` (emitted before `sleep`) reaches the parent's `onData`. `HUP_RECEIVED` (emitted by the trap handler, *during* the SIGHUP) does not. This means the PTY master read is dead by the time the handler runs — node-pty has already stopped pumping data toward the parent, or the master fd has been closed/EOF'd on Bun's side, even though the child is still alive and writing.

This is a two-step failure:

1. Bun closes / stops reading from the PTY master after the child's *first* output flush (typically a single line + newline).
2. The slave-side close handling in node-pty (or the kernel's controlling-terminal semantics) sees the master gone and SIGHUPs the foreground process group.

The second step is standard POSIX. The first step is the Bun-specific anomaly.

### 3.3 Trivially-quick children survive

```bash
#!/bin/bash
echo PID=$$
echo done
exit 42
```

Under Bun + node-pty: `EXIT: {"exitCode":42,"signal":0}`, full output. The child exits before the master-close race fires.

Add `sleep 0.1` between the two echoes and: `EXIT: {"exitCode":0,"signal":1}`, only the first echo's output. The race becomes deterministic the moment the child is alive long enough to be vulnerable.

### 3.4 The Go canonical works

The Go binary (`fnclaude@fnrhombus`) does exactly the same dance — `cmd := exec.Command(...)`, `pty.Start(cmd)`, then `io.Copy(io.MultiWriter(os.Stdout, ring), ptmx)` blocking-read from master until child exit (`src/pty_run_unix.go:35–157`). It works. claude launches and runs fine. So:

- The shape of the pipeline (auto-handoff socket, env injection, cwd ensure, raw-mode setup, signal forwarding) is **not** the bug. The TS code mirrors it.
- The PTY-master read pattern matters. Go does a blocking goroutine read; TS uses node-pty's `onData` callback. Whether `onData` is the cleanly-correct shape under Bun is unproven.

### 3.5 Fake claude tests pass because they `trap '' HUP`

`packages/cli/test/e2e/argv-passthrough.test.ts` and `exit-code.test.ts` ship a bash fake that begins with `trap '' HUP`. That makes the fake immune to the very signal that kills real claude. Every e2e test in the repo silently relies on this — the tests confirm fnclaude *would* spawn claude correctly *if claude ignored SIGHUP*, but they cannot detect that real claude doesn't ignore it.

This is the most important point for the rewrite's test design: **drop the `trap '' HUP`** in any future PTY-spawn test, or the test is paper. A test that doesn't reproduce the silent-exit bug under Bun + node-pty isn't testing the runtime that ships.

### 3.6 The autoname path works

`claude -p --model <model> <prompt>` invoked via `Bun.spawn` (NOT under a PTY) works. It returns exit code 0 with the model's response on stdout. The bug is exclusively in the **interactive** PTY path. `packages/cli/src/autoname.ts`'s `defaultSpawnFn` is fine.

This rules out "Bun can't spawn claude at all" and narrows the bug to "Bun + PTY master fd lifecycle."

## 4. Reproduction recipe

### 4.1 Inside the actual fnclaude install (closest to user-reported symptom)

```bash
# Hermetic-ish, no tmux required; ghostty or any terminal:
FNC_ARGS_JSON='["--","say hi"]' bun /home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/lib/node_modules/@fnclaude/cli/bin/fnc.js
# Observed: silent exit, RC=0.
```

This bypasses the Node shim (`bin/fnc.js`'s re-exec dance) and invokes Bun directly on the entry — same behaviour, faster to iterate on.

### 4.2 Minimal reproducer (no fnclaude code involved at all)

```bash
cd /home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/lib/node_modules/@fnclaude/cli
bun -e '
import pty from "node-pty";
const p = pty.spawn("claude", ["--version"], {
  name: "xterm", cols: 80, rows: 24, cwd: "/tmp",
  env: process.env, encoding: null,
});
let data = "";
p.onData((chunk) => { data += (Buffer.isBuffer(chunk) ? chunk.toString() : chunk); });
p.onExit((e) => { console.log("EXIT:", JSON.stringify(e), "DATA:", JSON.stringify(data)); process.exit(0); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 6000);
'
# EXIT: {"exitCode":0,"signal":1} DATA: ""
```

Swap `bun` for `node` and run the same one-liner (with require()-shape instead of import) — it works, prints the version, exits clean.

### 4.3 The cleanest discriminator (no claude required)

```bash
cd /home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/lib/node_modules/@fnclaude/cli
# Bun: SIGHUP after first echo
bun -e '
import pty from "node-pty";
import {writeFileSync, chmodSync, mkdtempSync} from "fs";
import {join} from "path"; import {tmpdir} from "os";
const d = mkdtempSync(join(tmpdir(), "pty-"));
const s = d + "/t.sh";
writeFileSync(s, "#!/bin/bash\necho FIRST\nsleep 0.5\necho SECOND\nexit 42\n");
chmodSync(s, 0o755);
const p = pty.spawn(s, [], {name:"xterm", cols:80, rows:24, cwd:"/tmp", env:process.env, encoding:null});
let d2 = ""; p.onData((c) => d2 += c.toString());
p.onExit((e) => { console.log("EXIT:", JSON.stringify(e), "DATA:", JSON.stringify(d2)); process.exit(0); });
'
# Bun  → EXIT: {"exitCode":0, "signal":1} DATA: "FIRST\r\n"  (SECOND never reached)
# Node → EXIT: {"exitCode":42,"signal":0} DATA: "FIRST\r\nSECOND\r\n"
```

This is the test that should drive the fix and should be in the rewrite's test suite (with `claude` substituted via injectable seam, but the underlying behaviour gated against the real Bun+pty pair).

### 4.4 What does NOT need to be present to reproduce

- tmux (reproduces in a bare ghostty session)
- the user's `handoff = "3"` config (reproduces with `handoff = "ask"` or no config)
- `auto.tmux = "worktree"` (reproduces with `"never"`)
- the FNC_ARGS_JSON env-var trick (reproduces with direct argv too)
- a real prompt (reproduces with `fnc` alone if you bypass the noop-fallback)
- shouldAutoName firing (reproduces even when no autoname path is taken)
- The SocketListener (reproduces with `hspec = undefined`)

The bug is in the PTY-spawn primitive, not the orchestration around it.

## 5. Direct evidence captured

### 5.1 Bun vs Node, same node-pty, same claude

```
$ cd /home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/lib/node_modules/@fnclaude/cli

$ bun  -e '... pty.spawn("claude", ["--version"], ...) ...'
EXIT: {"exitCode":0, "signal":1} DATA: ""

$ node -e '... pty.spawn("claude", ["--version"], ...) ...'
EXIT: {"exitCode":0, "signal":0} DATA: "2.1.152 (Claude Code)\r\n"
```

Identical everything *except the JS runtime*. The runtime is the bug.

### 5.2 SIGHUP trap discriminator

Script:

```bash
#!/bin/bash
echo PID=$$
trap "echo HUP_RECEIVED; exit 77" SIGHUP
sleep 0.5
echo NORMAL_EXIT
exit 33
```

Under Bun + node-pty: `EXIT: {"exitCode":77,"signal":0} DATA: "PID=…\r\n"` — exit 77 *only* reachable via the SIGHUP path; HUP_RECEIVED output never seen.

### 5.3 node-pty version is not the discriminator

- Workspace `bun.lock` pins `node-pty@1.2.0-beta.13`
- Workspace `node_modules/.bun/node-pty@1.1.0/` is a stale hoisting artefact; what `require.resolve` returns from the workspace package, but **not** what the installed CLI uses.
- Installed CLI at `/home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/lib/node_modules/@fnclaude/cli/node_modules/node-pty/` is 1.2.0-beta.13.
- Both versions exhibit the bug identically under Bun. Tested both. Not a version issue.

The workspace's stale 1.1.0 hoisting is its own minor issue (it means in-repo `bun` invocations don't run the pinned version), but it's **not** the silent-exit bug. The rewrite should still clean it up, but separately.

## 6. Ruled-out hypotheses (and why)

Each entry: hypothesis → evidence that excluded it.

### 6.1 "FNC_ARGS_JSON leaks into child env"
Evidence: `packages/cli/src/main.ts:164–181` (`readArgvFromEnvOrProcess`) explicitly `delete process.env.FNC_ARGS_JSON` after consumption. Confirmed in repro: removing FNC_ARGS_JSON and using direct argv reproduces the bug identically.

### 6.2 "`handoff = '3'` causes pre-PTY exit"
Evidence: `packages/cli/src/config.ts:normalizeHandoffMode("3")` returns `{ value: "3", warning: undefined }` — valid. The handoff spec construction in `main.ts:425–430` succeeds. PTY spawn IS reached. Confirmed by replacing `cfg.auto.handoff` with `"ask"` — same bug.

### 6.3 "`SocketListener.start` failing silently"
Evidence: `packages/cli/src/mcp/socketListener.ts:158–200` — start() throws on any bind/chmod failure; `runWithPTY` catches and writes to stderr (`pty/unix.ts:296–312`) with `return { exitCode: 1, ... }`. Silent RC=0 cannot come from this path. Also confirmed by setting `handoff = undefined` (no listener at all) — same bug.

### 6.4 "`lookupClaudeFromPath` returns undefined"
Evidence: `which claude` resolves. The `main.ts:419–422` guard would print `fnclaude: claude not found in PATH` and `return 1`. Output is empty; RC is 0. Not this.

### 6.5 "`loadPrompts` throws and aborts"
Evidence: `packages/cli/src/prompts.ts` returns warnings rather than throwing. Even on prompt-dir absence, `prompts.set` is empty and `buildArgv` continues. Confirmed by setting `FNC_PROMPTS_DIR` to a known-good location — same bug.

### 6.6 "Autoname (`claude -p`) hangs or crashes"
Evidence: standalone `Bun.spawn(['claude', '-p', '--model', 'claude-haiku-4-5', 'Say hi'], …)` returns exit 0 with model output. Autoname succeeds. The bug is downstream, in the PTY spawn for the interactive session.

### 6.7 "Bun strips the second `--` from argv"
Evidence: the FNC_ARGS_JSON env-var trick exists exactly to avoid this, and is working (confirmed by injecting `runWithPTY` mock and observing the argv it receives: `["--mcp-config", …, "--name", "say-hi", "--append-system-prompt", …, "--", "say hi"]` — all intact). Not the bug.

### 6.8 "claude can't be spawned by Bun at all"
Evidence: §3.6. `claude -p` via `Bun.spawn` works. The bug is specifically the PTY path.

### 6.9 "node-pty version mismatch (1.1.0 vs 1.2.0-beta.13)"
Evidence: §5.3. Both versions exhibit the bug identically. Cleanup-worthy on its own, but not the bug.

### 6.10 "missing setsid → claude has no controlling terminal"
Evidence: `forkpty(3)` (used internally by node-pty on Linux, see `node_modules/.bun/node-pty@1.1.0/node_modules/node-pty/src/unix/pty.cc:399`) calls `setsid()` in the child and `ioctl(TIOCSCTTY)` to make the slave the controlling TTY. The child *does* have a controlling terminal — confirmed by `tty` reporting `/dev/pts/9` from inside a PTY-spawned bash. Not this.

### 6.11 "process hierarchy from the `spawnSync` Bun re-exec breaks something"
Evidence: §4.2 reproduces with direct `bun` invocation, no shim, no re-exec. Not this.

## 7. Live hypotheses (still candidates)

### 7.1 PRIMARY: Bun's `tty.ReadStream` over node-pty's master fd closes early

Node's `tty.ReadStream` wraps the master fd in libuv and pulls data continuously. node-pty 1.x uses `tty.ReadStream` directly (`unixTerminal.js:93–141`): `_this._socket = new tty.ReadStream(term.fd)`. Bun's `tty.ReadStream` compatibility shim may:

- mark the stream "ended" after a single read flush
- pause the underlying libuv handle in a way that lets the kernel see no reader on the master
- emit `close` on the socket prematurely, which triggers node-pty's `_close()` → fd close → kernel SIGHUPs the slave-side foreground process group

The handler at `unixTerminal.js:134–141` calls `_this._close()` on socket close, which (per the same file) closes the master fd. Once master is closed, kernel sends SIGHUP to slave's session leader. This matches exactly the observed symptom — child gets SIGHUP, child's post-SIGHUP output never reaches parent (master is dead).

**To distinguish**: instrument the test reproducer with `p._socket.on('close', () => …)`, `p._socket.on('end', () => …)`, `p.on('close', ...)` and timestamp every event. If `close` on `_socket` fires before child exit, this hypothesis is confirmed.

Also worth instrumenting: `strace -e trace=close,read,write -f -p <bun-pid>` to see when fd close on the master fd actually happens.

### 7.2 SECONDARY: Bun-specific N-API or libuv interaction with the prebuild

node-pty's native module is loaded via N-API (the prebuild for `linux-x64`). Bun has an N-API compat layer. If the `posix_spawn` or `forkpty` path returns control to Bun and Bun's polling on the master fd is the broken bit, the symptom is the same as 7.1 — but the FIX is different. (E.g. the fix might be to use `fs.createReadStream` on the fd instead of `tty.ReadStream`, or to call `node-pty`'s `master` accessor pattern differently.)

**To distinguish**: try `pty.open()` (the lower-level node-pty API that hands back master/slave fds without `tty.ReadStream` wrapping) and read the master via `fs.createReadStream`. If that fixes it, the bug is the ReadStream layer.

### 7.3 TERTIARY: node-pty's `onexit` callback fires before EOF drain on master

In `unixTerminal.js:65–90`, `onexit` is called by the native module when the child exits. If under Bun the native `onexit` triggers before the master-fd data has been fully drained, the `_socket.destroy()` timeout at line 76–80 forces a close, dropping the last buffer. This would explain SOME data being seen but post-SIGHUP-trap output being lost.

**To distinguish**: log the order of native `onexit` vs the last `onData` chunk. If `onexit` precedes the data the test expects, this is the issue.

### 7.4 QUATERNARY: claude exits, *then* SIGHUP is reported

Per the codebase note (`packages/cli/src/pty/unix.ts:410–416`), Bun observed `signal: 1` on normal exits. It's POSSIBLE the "SIGHUP" we're seeing is a node-pty/Bun reporting glitch and the child genuinely exited normally with `exit(0)`. The trap test in §3.1 disconfirms this — the trap handler ran (exit 77) — but only for that bash test, not for claude itself. Maybe claude is exiting because of *some other thing* and the SIGHUP report is the glitch.

**To distinguish**: `strace -f -e trace=exit_group,kill,rt_sigaction,sigaction` on the claude process spawned by Bun + node-pty. If `exit_group(0)` appears with no preceding fatal signal, this hypothesis wins. If a SIGHUP delivery (or `kill(claude_pid, SIGHUP)` from the kernel) precedes exit, hypothesis 7.1/7.2/7.3 wins.

This is the lowest-probability hypothesis — the bash trap test is fairly strong evidence SIGHUP delivery is real. But it should be conclusively ruled out under claude specifically before the rewrite commits to a fix shape.

## 8. File:line references

All paths are into the installed CLI at `/home/tom/.local/share/mise/installs/npm-fnclaude-cli/1.1.1/lib/node_modules/@fnclaude/cli/`. The worktree's `packages/cli/src/` had identical contents before the wipe.

| Path | Lines | Role |
|---|---|---|
| `src/main.ts` | 164–181 | `readArgvFromEnvOrProcess` — FNC_ARGS_JSON consume + delete. Ruled out as bug source. |
| `src/main.ts` | 208–462 | `run()` pipeline orchestration. Reaches `runPTY()` at line 431. |
| `src/main.ts` | 387–397 | shouldAutoName / generateName path. Works fine; not the bug. |
| `src/main.ts` | 419–422 | claude PATH lookup. Returns valid path. |
| `src/main.ts` | 425–430 | HandoffSpec construction. cfg.auto.handoff="3" parses fine. |
| `src/pty/unix.ts` | 274–429 | `runWithPTY` — main PTY runner. Pipeline correct; the runtime under it fails. |
| `src/pty/unix.ts` | 329–348 | `ptySpawn` call. Args correct. |
| `src/pty/unix.ts` | 368–372 | `onData` registration. Drains data when data arrives — but data stops arriving after first chunk under Bun. |
| `src/pty/unix.ts` | 393–403 | One-shot `onExit` handler. Sees `{exitCode: 0, signal: 1}` (SIGHUP). |
| `src/pty/unix.ts` | 410–416 | Comment noting Bun's `signal` field is "unreliable." **Wrong**: it's correct, the interpretation note needs revising. |
| `src/autoname.ts` | (whole) | `claude -p` autoname path via `Bun.spawn`. Works. Not the bug. |
| `src/mcp/socketListener.ts` | 158–200 | `SocketListener.start`. Throws would propagate; not the silent-exit path. |
| `node_modules/node-pty/lib/unixTerminal.js` | 65–90 | `onexit` callback wiring. Possible early-fire under Bun (hypothesis 7.3). |
| `node_modules/node-pty/lib/unixTerminal.js` | 93 | `new tty.ReadStream(term.fd)` — primary suspect for the Bun shim issue (hypothesis 7.1). |
| `node_modules/node-pty/lib/unixTerminal.js` | 134–141 | Socket close handler → `_close()`. Where the master fd gets closed prematurely if 7.1. |
| Go reference: `/home/tom/src/fnclaude@fnrhombus/src/pty_run_unix.go` | 35–157 | Working canonical. `io.Copy(MultiWriter, ptmx)` blocking read in a goroutine — *different* read shape than node-pty's `onData`. |

## 9. What the rewrite should actually do

Listed in priority order.

### 9.1 Pick the runtime first, then the library

This investigation made it clear: the choice between `bun` and `node` as the runtime is **load-bearing**, not a stylistic preference. The current "use Bun for everything" stance has trapped fnclaude into a runtime that has a broken PTY interaction with the library it depends on. The rewrite needs to pick one of these explicitly:

**Option A: Stay on Bun, replace node-pty.** Use a different PTY shim — maybe a hand-rolled `forkpty(3)` via `bun:ffi` or `Bun.dlopen`, or use Bun's native `Bun.spawn` once Bun ships PTY support natively. Riskier (more code to maintain), better runtime story long-term.

**Option B: Switch to Node, keep node-pty.** Drop the Node shim's "prefer Bun" branch; just run on Node. node-pty works fine. Lose Bun's startup speed advantage but the PTY problem evaporates. Lowest-risk path.

**Option C: Wrap claude's PTY in a child Node process from Bun.** Bun spawns a thin Node helper, the helper does the PTY dance, IPCs the output back to Bun. Worst of both worlds; do not pick this.

Recommendation: **Option B unless someone has measured the Bun startup-time win is worth the rewrite cost of Option A.** The published binary already pays Node's startup via the shim — Bun was only a runtime advantage for the re-exec'd inner process, and that process is now known to be the broken one.

### 9.2 Replicate the Go read pattern, not the node-pty event pattern

Go does `io.Copy(MultiWriter(stdout, ring), ptmx)` — a blocking read on the master that pulls bytes until the master is closed (typically because the child exited). This is a single, well-defined loop. node-pty's `onData` callback is a libuv-driven event stream; under Bun's shim it apparently has different lifecycle semantics.

If staying on Node, this difference matters less (node-pty + Node was the reference design for node-pty). If considering Bun + node-pty long-term, design the read loop to be tolerant of premature `close` events on the underlying stream, e.g. by reading from the raw fd via `fs.createReadStream` after the initial spawn.

### 9.3 Stop using `trap '' HUP` in PTY-spawn tests

`packages/cli/test/e2e/argv-passthrough.test.ts` and `exit-code.test.ts` have fake-claude bash scripts beginning with `trap '' HUP`. **This makes the tests useless against the actual runtime bug they were supposed to catch.** A passing test with that line is not evidence that real claude will survive. Remove the trap from the fakes; if the fakes then fail to survive their own spawn, that IS the regression test.

### 9.4 Add a smoke test that hits real claude (or a real ELF) under PTY

A test invoking `claude --version` (or any short-lived ELF) via the chosen PTY shim, asserting both `signal === 0` and non-empty output. This is a 5-line test that would have caught the bug immediately. The repo's e2e suite has no such test; that gap is how the bug shipped.

### 9.5 Fix the node-pty hoisting drift

`bun.lock` pins `1.2.0-beta.13` but `node_modules/.bun/` has `1.1.0` from somewhere. Probably a transitive — find and pin it, or set up Bun to lock the workspace-level resolution. Not the bug, but it'll keep biting if not fixed: anyone testing locally with `bun packages/cli/src/main.ts` gets a different node-pty than the published binary does.

### 9.6 Don't put `--no-bun-strip-double-dash`-shaped workarounds anywhere they'll lose context

The FNC_ARGS_JSON dance (`bin/fnc.js` sets it, `main.ts` reads it) is a real Bun behaviour and the workaround is correct, but it's also a load-bearing piece of cross-runtime glue that's easy to delete. Make sure the rewrite either keeps it (with the comment block intact) OR replaces it with a runtime that doesn't have the `--` issue. Document the trade-off in code; this investigation lost an hour to "is FNC_ARGS_JSON leaking?" before ruling it out.

## 10. Bun + node-pty caveats to encode in the rewrite

- **`signal` field semantics**: Under Bun, `pty.onExit({signal})` does report SIGHUP correctly when it fires, but the codebase's "Bun's signal is unreliable" note has caused confusion. Update the comment block when porting: SIGHUP is real, and indicates either (a) the slave-side process was killed by losing its controlling terminal, or (b) Bun's premature master close. Either way it's a signal to investigate, not a noop.
- **`onData` lifecycle**: node-pty's `onData` callback's stream may end (silently) before the child does, under Bun. Any reader of the data stream needs to handle "child still running but data has stopped" as a possible state.
- **`tty.ReadStream` shim**: Bun's `tty.ReadStream` compatibility shim is the most likely fault line. Avoid features that depend on its full Node-compatible behaviour. `fs.createReadStream` on a raw fd is more likely to work consistently.
- **`forkpty` / setsid**: node-pty on Linux uses `forkpty(3)` which DOES call `setsid()`. Don't try to add a `setsid` wrapper around the child as a fix — it's already there. The bug is downstream of fork.
- **`pty.open()` instead of `pty.spawn()`**: node-pty exposes a lower-level `open()` returning `{master, slave, pid}` fds that the caller wires up themselves. Using this and managing fd lifecycle explicitly may dodge the Bun ReadStream issue. Untested in this investigation; promising avenue.
- **Direct `Bun.spawn` for PTY-like cases**: For one-shot `claude -p` (no interactive PTY needed), `Bun.spawn` works perfectly. Don't push every claude invocation through PTY just for consistency; the autoname path is fine as a non-PTY subprocess. The rewrite should keep that separation.

## 11. What I wish I'd done first

1. **Run the same `pty.spawn(claude, …)` snippet under `node`** within the first 10 minutes. That alone tells you it's Bun-specific and saves a couple of hours chasing fnclaude's pipeline.
2. **Notice `trap '' HUP` in the fake** earlier. The tests passing while the real binary fails is a *gigantic* tell that the tests are lying. I noticed it but spent too long ruling out other things first.
3. **Read the Go canonical's `pty_run_unix.go` early.** It's small and clearly written; spotting that Go uses a blocking `io.Copy` loop (versus node-pty's callback shape) primes you for the "library/runtime interaction" hypothesis before you go fishing in fnclaude's pipeline.
4. **Skip the orchestration debugging.** The bug being downstream of `runWithPTY`'s `ptySpawn` call was the obvious shape from the symptom (RC=0, no output, no claude UI). I spent investigation budget on FNC_ARGS_JSON, SocketListener, handoff config, etc. — none of them could have caused silent RC=0 (they all have error-path stderr + RC=1 exits). Should have gone straight at the PTY library.
5. **Pin node-pty version actually-in-use early.** The hoisting drift between workspace 1.1.0 and installed-CLI 1.2.0-beta.13 is the kind of thing that wastes 20 minutes if you assume what's in `package.json` is what's running.

## 12. Open questions for the rewrite

- Is staying on Bun a deliberate choice or just inertia from the TS port template? If the latter, Option B (Node) is strictly better given what we now know.
- Does the rewrite intend to drop the AF_UNIX MCP socket entirely, or keep it? If keep, the PTY-spawn behaviour is still the gate — the socket listener's lifecycle is fine.
- Is `node-pty` itself the right abstraction, or should the rewrite take a swing at calling `forkpty(3)` directly via FFI? More code, but escapes the ReadStream shim path. Probably overkill if Node fixes the immediate problem.
- Should the rewrite even *be* a PTY-wrapping CLI? A simpler design would be to `execve` straight into claude with `[exec.env]` injected and the auto-handoff socket on a sidecar, never owning a PTY at all. Doesn't apply to cross-cwd resume (which needs to read claude's output), but worth thinking through.
