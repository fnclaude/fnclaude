/**
 * §8.4 — Clipboard backend detection + invocation (pure module).
 *
 * Backend priority per design.md §25 + design.mcp.md §4.4:
 *
 *   1. `wl-copy`   (Wayland)
 *   2. `xclip`     (X11 — preferred over xsel)
 *   3. `xsel`      (X11 fallback)
 *   4. `pbcopy`    (macOS)
 *   5. `clip.exe`  (Windows / WSL — reachable on WSL via PATH)
 *
 * Detection here is by `which`-style PATH lookup, not by the GOOS+env
 * gating the Go canonical uses. That's intentional for the rewrite: a
 * Linux box without WAYLAND_DISPLAY but with `xclip` on PATH will still
 * work; on WSL `clip.exe` is reachable from a "linux" runtime; on macOS
 * only `pbcopy` is in PATH by default. The injected `which` keeps tests
 * pure.
 *
 * Each backend takes the clipboard payload via stdin and writes nothing
 * useful to stdout. Exit 0 = success. The handler never throws — spawn
 * failures, exec failures, non-zero exits all flow back as `false` so
 * the caller can report `clipboard_ok: false` without lighting up an
 * error path the model doesn't expect.
 */

/** Locate an executable on PATH, returning its absolute path or null. */
export type WhichFn = (name: string) => string | null;

/**
 * Minimal spawn surface we exercise from this module. The real
 * implementation is a thin adapter over `Bun.spawn` (see {@link defaultSpawn}).
 * Tests inject a fake to avoid touching real processes.
 */
export interface SpawnedProc {
  stdin: {
    write(chunk: string | Uint8Array): void;
    end(): void;
  };
  exited: Promise<number>;
  kill(): void;
}

export type SpawnFn = (
  args: readonly string[],
  opts: { stdin: 'pipe' },
) => SpawnedProc;

export interface Backend {
  name: 'wl-copy' | 'xclip' | 'xsel' | 'pbcopy' | 'clip.exe';
  command: string;
}

const PRIORITY: ReadonlyArray<Backend['name']> = [
  'wl-copy',
  'xclip',
  'xsel',
  'pbcopy',
  'clip.exe',
];

/**
 * Walk the priority list and return the first backend whose executable
 * `which` finds. Returns null if nothing is installed.
 */
export function detectBackend(args: { which: WhichFn }): Backend | null {
  for (const name of PRIORITY) {
    const command = args.which(name);
    if (command !== null && command !== '') {
      return { name, command };
    }
  }
  return null;
}

function backendArgs(name: Backend['name']): readonly string[] {
  // Selection flags matter for X11 — without `-selection clipboard` xclip
  // writes to the PRIMARY selection (middle-click paste), not the
  // clipboard the user reaches via Ctrl-V. Same shape for xsel's `-ib`.
  switch (name) {
    case 'xclip':
      return ['-selection', 'clipboard'];
    case 'xsel':
      return ['-ib'];
    case 'wl-copy':
    case 'pbcopy':
    case 'clip.exe':
      return [];
  }
}

export interface RunBackendArgs {
  backend: Backend;
  text: string;
  spawn: SpawnFn;
}

/**
 * Invoke the chosen backend, piping `text` to its stdin. Returns true on
 * clean exit (code 0), false on any failure: spawn throwing, stdin write
 * throwing, non-zero exit, or the exited promise rejecting.
 *
 * Crucially, this function never throws. The caller relies on the
 * boolean return to populate `clipboard_ok`.
 */
export async function runBackend(args: RunBackendArgs): Promise<boolean> {
  const argv = [args.backend.command, ...backendArgs(args.backend.name)];
  let proc: SpawnedProc;
  try {
    proc = args.spawn(argv, { stdin: 'pipe' });
  } catch {
    return false;
  }

  try {
    proc.stdin.write(args.text);
    proc.stdin.end();
  } catch {
    // stdin closed early or the process died before we could write.
    // Make sure the spawned process isn't lingering, then report
    // failure. Some backends (xclip on Wayland-only boxes, for one)
    // exit immediately on EPIPE and we shouldn't wait on exited
    // forever; the kill is best-effort.
    try {
      proc.kill();
    } catch {
      // ignore
    }
    return false;
  }

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } catch {
    return false;
  }
  return exitCode === 0;
}

/**
 * Production `which`: thin wrapper around Bun.which. Returns null when
 * the name isn't on PATH; both `null` and `undefined` from Bun.which are
 * treated as "not found".
 */
export const defaultWhich: WhichFn = (name) => {
  const r = Bun.which(name);
  return r === null || r === undefined ? null : r;
};

/**
 * Production `spawn`: adapter that yields the minimal SpawnedProc shape
 * over Bun.spawn. We pipe stdin (for the text payload), ignore stdout
 * (no useful output from these backends), and inherit stderr so a real
 * misconfiguration surfaces in the parent's terminal during development.
 */
export const defaultSpawn: SpawnFn = (args, _opts) => {
  const proc = Bun.spawn([...args], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  return {
    stdin: {
      write(chunk: string | Uint8Array) {
        proc.stdin.write(chunk);
      },
      end() {
        proc.stdin.end();
      },
    },
    exited: proc.exited,
    kill() {
      proc.kill();
    },
  };
};
