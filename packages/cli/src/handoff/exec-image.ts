/**
 * True process-image replacement (execve) for the relaunch paths.
 *
 * Go canonical replaces the running fnclaude image in place with
 * `syscall.Exec` so a restart / cross-cwd resume leaves exactly ONE fnc
 * process per session. The TS port originally lacked an execve binding and
 * fell back to `Bun.spawn(child) + await child.exited + process.exit` — but
 * for a long-running interactive child that never returns on its own, the
 * parent waits forever, so every in-session restart leaves the old
 * generation alive as an idle ancestor. The process tree grows one
 * generation per restart (#205 symptom 1).
 *
 * Bun has no native execve, but libc's `execve` is reachable through
 * `bun:ffi`. `execve` replaces the current process image and (on success)
 * NEVER returns — exactly the semantics we need. We use `execve` (not
 * `execvp`) because the new image needs an explicit `envp`: Bun's
 * `process.env` is a JS proxy whose writes do NOT propagate to the libc
 * `environ` that the *p-family / v-family inherit, so the relaunched image
 * would otherwise see a stale FNC_ARGS_JSON (and re-run the original argv).
 * Passing an explicit envp built from the caller's env sidesteps that. The
 * binary path is `argv[0]` (callers pass an absolute `process.execPath`), so
 * no PATH search is needed.
 *
 * Platform support: Linux + macOS via libc. On any other platform, or if
 * the dlopen / symbol lookup fails, `execImage` returns `false` so the
 * caller can fall back to the spawn-and-wait shim (the pre-#205 behaviour —
 * stacking, but functional). Returns `never` on success because execve does
 * not return when it replaces the image.
 */

type ExecveFn = (
  path: string,
  argv: readonly string[],
  env: Record<string, string | undefined>,
) => number;

let cachedExecve: ExecveFn | null | undefined;

/**
 * Resolve a bound `execve(path, argv, env)` wrapper, or null when FFI/libc
 * isn't available on this platform. Cached after the first call.
 */
function resolveExecve(): ExecveFn | null {
  if (cachedExecve !== undefined) return cachedExecve;
  cachedExecve = buildExecve();
  return cachedExecve;
}

function libcCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['libc.dylib', 'libSystem.B.dylib'];
  if (platform === 'win32') return [];
  // Linux + other ELF unices.
  return ['libc.so.6', 'libc.so'];
}

/**
 * Build a NULL-terminated `char**` from string tokens, returning the
 * pointer array plus the backing buffers (the caller must keep both alive
 * until the FFI call returns so GC can't free the strings mid-call).
 */
function buildCharPtrArray(
  ptr: (b: NodeJS.TypedArray) => number,
  tokens: readonly string[],
): { arr: BigInt64Array; bufs: Buffer[] } {
  const bufs = tokens.map((t) => Buffer.from(`${t}\0`, 'utf8'));
  const arr = new BigInt64Array(tokens.length + 1);
  for (let i = 0; i < bufs.length; i++) {
    arr[i] = BigInt(ptr(bufs[i]!));
  }
  arr[tokens.length] = 0n;
  return { arr, bufs };
}

function buildExecve(): ExecveFn | null {
  const candidates = libcCandidates(process.platform);
  if (candidates.length === 0) return null;

  // bun:ffi is only importable under Bun; guard so a non-Bun runtime (or a
  // future platform without FFI) degrades to the spawn fallback.
  let ffi: typeof import('bun:ffi');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ffi = require('bun:ffi') as typeof import('bun:ffi');
  } catch {
    return null;
  }
  const { dlopen, FFIType, ptr } = ffi;

  for (const lib of candidates) {
    try {
      const handle = dlopen(lib, {
        execve: {
          // int execve(const char *path, char *const argv[], char *const envp[])
          args: [FFIType.cstring, FFIType.ptr, FFIType.ptr],
          returns: FFIType.int,
        },
      });
      const sym = handle.symbols.execve;
      return (
        path: string,
        argv: readonly string[],
        env: Record<string, string | undefined>,
      ): number => {
        const envTokens: string[] = [];
        for (const [k, v] of Object.entries(env)) {
          if (v !== undefined) envTokens.push(`${k}=${v}`);
        }
        // Keep both backing-buffer arrays referenced through the call.
        const a = buildCharPtrArray(ptr, argv);
        const e = buildCharPtrArray(ptr, envTokens);
        const pathBuf = Buffer.from(`${path}\0`, 'utf8');
        // On success execve never returns; on failure it returns -1 and the
        // process continues here.
        return Number(sym(ptr(pathBuf), ptr(a.arr), ptr(e.arr)));
      };
    } catch {
      // Try the next candidate library name.
    }
  }
  return null;
}

/**
 * Replace the current process image with `argv[0]` (an absolute binary
 * path — no PATH search), passing the full `argv` and an explicit `env`.
 * Returns `false` when execve isn't available on this platform (caller
 * should fall back to spawn). On success it never returns; the `false`
 * return type documents the only path that does.
 *
 * The injectable `execve` seam exists for tests — production omits it and
 * the libc binding is used.
 */
export function execImage(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  execve?: ExecveFn,
): false {
  const fn = execve ?? resolveExecve();
  if (fn === null) return false;
  if (argv.length === 0) return false;
  fn(argv[0]!, argv, env);
  // Only reached if execve failed (returned -1). Surface as "not replaced"
  // so the caller can fall back rather than hang.
  return false;
}
