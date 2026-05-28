/**
 * §8.3 — pure env scrubber for `fnc_spawn_session`.
 *
 * The spawned sibling fnclaude is its own independent session, so the
 * three session-scoped vars must NOT leak across the spawn boundary:
 *
 *   - `FNC_SOCKET` points at *this* parent's listener; the sibling has
 *     to compute its own socket path. If we leaked it, the new
 *     claude's MCP subprocess would dial back into us instead of its
 *     own parent.
 *   - `FNCLAUDE_HANDOFF` was injected for *this* session's claude.
 *   - `CLAUDE_CODE_SESSION_ID` likewise scopes to this session.
 *
 * Everything else (`PATH`, `XDG_*`, exec.env contributions, etc.)
 * passes through unchanged so the sibling inherits the same user
 * environment.
 *
 * Ports Go canonical's `cleanEnvForSpawn` (`fnclaude@fnrhombus/src/spawn.go`).
 * The TS shape is a `Record<string,string>` because Bun.spawn's `env`
 * option takes the object form; Go was producing `KEY=VALUE` slices for
 * `exec.Cmd.Env`. Same semantics either way.
 */

const DROP: ReadonlySet<string> = new Set([
  'FNC_SOCKET',
  'FNCLAUDE_HANDOFF',
  'CLAUDE_CODE_SESSION_ID',
]);

/**
 * Return a fresh env object with the three session-scoped keys removed.
 * Non-string values (undefined slots on process.env) are skipped — the
 * Bun.spawn `env` contract is `Record<string,string>`.
 */
export function cleanEnvForSpawn(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (DROP.has(k)) continue;
    if (typeof v !== 'string') continue;
    out[k] = v;
  }
  return out;
}
