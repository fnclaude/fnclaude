// Port of src/clipboard.go from the Go reference implementation.
//
// pickClipboardTool — detects the platform-appropriate clipboard binary.
// copyToClipboard   — spawns that binary and pipes text into its stdin.

// ── types ────────────────────────────────────────────────────────────────────

/** Encodes the platform-detected clipboard tool choice. */
export interface ClipboardTool {
  name: string;
  args: string[];
}

/**
 * SpawnResult is the injectable seam used in tests to avoid exec'ing real
 * clipboard binaries. Production code calls defaultSpawnClipboard.
 */
export type ClipboardSpawnFn = (
  name: string,
  args: string[],
  text: string,
) => Promise<void>;

// ── detection ─────────────────────────────────────────────────────────────────

/**
 * pickClipboardTool returns the first tool that matches the current runtime
 * + environment, or null if no supported clipboard integration is available.
 *
 * Detection rules (matches the Go reference):
 *
 *   Linux (Wayland — $WAYLAND_DISPLAY set): wl-copy
 *   Linux (X11    — $DISPLAY set):          xclip -selection clipboard
 *   macOS (process.platform === 'darwin'):  pbcopy
 *   Windows (process.platform === 'win32'): clip
 *
 * Pure function of (platform, env-lookup) — trivially testable without
 * exec'ing anything.
 */
export function pickClipboardTool(
  platform: NodeJS.Platform,
  env: (key: string) => string | undefined,
): ClipboardTool | null {
  switch (platform) {
    case 'linux': {
      if (env('WAYLAND_DISPLAY')) {
        return { name: 'wl-copy', args: [] };
      }
      if (env('DISPLAY')) {
        return { name: 'xclip', args: ['-selection', 'clipboard'] };
      }
      // Headless Linux: no supported tool.
      return null;
    }
    case 'darwin':
      return { name: 'pbcopy', args: [] };
    case 'win32':
      return { name: 'clip', args: [] };
    default:
      return null;
  }
}

// ── spawn implementation ──────────────────────────────────────────────────────

/**
 * defaultClipboardSpawn spawns cmd with args and writes text to its stdin
 * using Bun.spawn. Throws on non-zero exit.
 */
export const defaultClipboardSpawn: ClipboardSpawnFn = async (name, args, text) => {
  const proc = Bun.spawn([name, ...args], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  // Write text into stdin then close it.
  const writer = proc.stdin;
  writer.write(text);
  await writer.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${name} exited with code ${exitCode}`);
  }
};

// ── xsel fallback ────────────────────────────────────────────────────────────

/**
 * xselFallback tries xsel --clipboard --input when xclip is unavailable or
 * fails. Returns true on success, false + error on failure.
 */
async function xselFallback(
  text: string,
  spawnFn: ClipboardSpawnFn,
): Promise<{ ok: boolean; err?: Error }> {
  try {
    await spawnFn('xsel', ['--clipboard', '--input'], text);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e as Error };
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * copyToClipboard writes text to the user's clipboard via the
 * platform-appropriate tool. Returns { ok: true } on success or
 * { ok: false, error } on failure (tool missing, exec error, no detector
 * matched, etc.).
 *
 * Detection precedence and tool choice are documented on pickClipboardTool.
 */
export async function copyToClipboard(
  text: string,
  spawnFn: ClipboardSpawnFn = defaultClipboardSpawn,
  platform: NodeJS.Platform = process.platform,
  env: (key: string) => string | undefined = (k) => process.env[k],
): Promise<{ ok: boolean; error?: Error }> {
  const tool = pickClipboardTool(platform, env);
  if (!tool) {
    return {
      ok: false,
      error: new Error(
        `no clipboard integration available for platform=${platform}`,
      ),
    };
  }

  try {
    await spawnFn(tool.name, tool.args, text);
    return { ok: true };
  } catch (primaryErr) {
    // X11 fallback: try xsel before giving up.
    if (tool.name === 'xclip') {
      const fb = await xselFallback(text, spawnFn);
      if (fb.ok) return { ok: true };
      return {
        ok: false,
        error: new Error(
          `xclip failed (${(primaryErr as Error).message}); xsel fallback failed (${fb.err?.message})`,
        ),
      };
    }
    return { ok: false, error: primaryErr as Error };
  }
}
