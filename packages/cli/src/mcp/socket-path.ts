/**
 * AF_UNIX socket path computation for the parent fnclaude MCP listener.
 *
 * Pure function — takes the env map and a pid, returns the resolved path.
 * Used by §7.2 to bind/listen, and by §6.1's env composition to set
 * FNC_SOCKET on the child claude.
 *
 * Path formula (per design.md §14, design.mcp.md §1–2):
 *
 *   <base>/fnclaude-mcp-<pid>.sock
 *
 * Base directory preference (highest precedence first):
 *   1. $XDG_RUNTIME_DIR — Linux/systemd tmpfs, mode 700, cleared on logout
 *   2. $TMPDIR          — honored on Unix when XDG isn't set
 *   3. /tmp             — final Unix fallback
 *
 * Empty-string env vars are treated as unset (matches Go canonical's
 * `os.Getenv("X") != ""` check at src/handoff.go:55–82).
 *
 * Windows: throws. The Windows path (named pipe) is a §7 follow-up; for
 * now the design.mcp.md §1 invariant — AF_UNIX with a PID-suffixed file
 * under XDG_RUNTIME_DIR/TMPDIR — is Unix-only, so failing loudly beats
 * returning a path the listener can't bind to.
 */

export interface ComputeSocketPathArgs {
  env: Record<string, string | undefined>;
  pid: number;
  platform: NodeJS.Platform;
}

export function computeSocketPath(args: ComputeSocketPathArgs): string {
  if (args.platform === 'win32') {
    throw new Error(
      'computeSocketPath: win32 not yet supported (AF_UNIX path only); see build-plan §7 follow-up',
    );
  }
  const base = resolveBaseDir(args.env);
  return `${base}/fnclaude-mcp-${args.pid}.sock`;
}

function resolveBaseDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg !== undefined && xdg !== '') return xdg;
  const tmp = env.TMPDIR;
  if (tmp !== undefined && tmp !== '') return tmp;
  return '/tmp';
}
