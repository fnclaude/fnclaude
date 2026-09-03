# Spawning interactive TUI children from Bun (2026-Q2)

Background research feeding the post-wipe CLI rewrite. Captured 2026-05-27.

## Verdict

- **MVP**: `Bun.spawn(["claude", …], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })`. The child sees `isTTY === true` because the parent's TTY fds pass through unchanged. No PTY layer, no open Bun bugs, no node-pty. Right default for a launcher.
- **Future**, once we need output capture / programmatic input / SIGWINCH relay: `Bun.Terminal` (landed v1.3.5, December 2025).
- **Do not** use `node-pty`. Confirmed broken under Bun on macOS arm64 (`onData` never fires — [oven-sh/bun#25822](https://github.com/oven-sh/bun/issues/25822)); the SIGHUP race we hit on Linux (see [`specs/archive/fnc-silent-exit-investigation.md`](archive/fnc-silent-exit-investigation.md)) is the same class.

## `inherit` semantics

| Aspect | Behavior |
|---|---|
| Child's `isTTY(stdin/stdout/stderr)` | `true` (fd passes through) |
| SIGINT/SIGTERM from kernel | Delivered to the foreground process group; child receives directly |
| SIGWINCH on parent terminal resize | Delivered to foreground process group; child receives directly |
| Output capture in parent | **Not possible** (no pipe) |
| Programmatic input injection | **Not possible** (no pipe) |

If `fnc` wants Ctrl-C to interrupt only `claude` and let `fnc` keep waiting for the exit code, install no-op handlers in the parent:

```typescript
process.on('SIGINT',  () => {}); // child still receives via kernel
process.on('SIGTERM', () => {});
const code = await proc.exited;
```

## `Bun.Terminal` (when we need it)

```typescript
const term = new Bun.Terminal({
  cols: process.stdout.columns ?? 80,
  rows: process.stdout.rows ?? 24,
  data(_t, chunk) { process.stdout.write(chunk); },
});

const proc = Bun.spawn(['claude', ...process.argv.slice(2)], {
  terminal: term,
  env: { ...process.env, TERM: 'xterm-256color' },
});

process.stdout.on('resize', () => term.resize(
  process.stdout.columns, process.stdout.rows,
));

process.stdin.setRawMode(true);
for await (const chunk of process.stdin) {
  // Workaround for #25779: line discipline doesn't forward Ctrl+C / Z / \
  // to the foreground process group. Intercept and route via proc.kill().
  for (const byte of chunk as Uint8Array) {
    if (byte === 0x03) { proc.kill('SIGINT');  continue; }
    if (byte === 0x1c) { proc.kill('SIGQUIT'); continue; }
    if (byte === 0x1a) { proc.kill('SIGTSTP'); continue; }
  }
  term.write(chunk);
}

process.exit((await proc.exited) ?? 0);
```

## Open Bun bugs to track

| Issue | Effect | Workaround |
|---|---|---|
| [#25779](https://github.com/oven-sh/bun/issues/25779) | `Bun.Terminal.write("\x03")` does not deliver SIGINT to foreground process group. PR [#25834](https://github.com/oven-sh/bun/pull/25834) (3-line fix, `setsid`+`TIOCSCTTY`) was closed stale. | Intercept control bytes in stdin loop; call `proc.kill()` explicitly. |
| [#25822](https://github.com/oven-sh/bun/issues/25822) | `node-pty` `onData` never fires on macOS arm64 under Bun 1.3.1+. | Drop node-pty. Use `Bun.Terminal` or `Bun.spawn` inherit. |
| [#25912](https://github.com/oven-sh/bun/issues/25912) | PTY allocation fails after macOS sleep/wake. | Detect `exit 0 + 0 bytes in ≤100ms` pattern and respawn. Low risk for one-invocation CLIs. |
| [#7362](https://github.com/oven-sh/bun/issues/7362) | Historical: `require('node-pty')` throws `Symbol not found: _node_module_register` on macOS. | Same as #25822 — don't use node-pty. |

## Alternatives surveyed (rejected)

- **`sursaone/bun-pty`** — Rust + Bun FFI backend, v0.4.8 (Jan 2026). Young (72 stars), adds Rust compile dependency, no production evidence vs. `Bun.Terminal`. Pass.
- **`@lydell/node-pty`, `node-pty-prebuilt-multiarch`** — share the same native binary as node-pty; inherit the same breakage. Pass.
- **FFI to libc `posix_openpt`/`grantpt`/`unlockpt`/`ptsname`** — works in principle but `Bun.Terminal` already exposes the same primitive via a stable API. Pass.

## References

- [Bun v1.3.5 release notes — `Bun.Terminal` introduction](https://bun.sh/blog/bun-v1.3.5)
- [Bun v1.3.14 release notes — Windows ConPTY + `--no-orphans`](https://bun.com/blog/bun-v1.3.14)
- [Bun docs — spawn API](https://bun.sh/docs/api/spawn)
