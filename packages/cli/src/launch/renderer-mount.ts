// Optional in-process renderer mount. When selected, fnc hosts the
// @fnclaude/renderer Ink app in its OWN process instead of spawning claude
// under a Bun.Terminal PTY (design.renderer.md §2). The renderer is an
// OPTIONAL dependency: it may not be installed, and the sibling PR that adds
// `mountRenderer` may not have landed yet — so every path here is defensive.
// A missing/old renderer must degrade to the normal PTY launch, never crash.

/** Handle returned by the renderer's `mountRenderer`. */
export interface RendererHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/** The shape we consume from `@fnclaude/renderer`. */
interface RendererModule {
  mountRenderer: (props?: unknown) => RendererHandle;
}

/**
 * Renderer-mode selector. Driven by the `FNC_RENDERER` env var so it stays
 * non-invasive (no argv/config surface yet — a CLI flag can come later).
 * Truthy values are exactly "1" and "true" (case-insensitive); everything
 * else — unset, empty, "0", "false", "yes", arbitrary garbage — is off.
 */
export function shouldUseRenderer(env: Record<string, string | undefined>): boolean {
  const raw = env.FNC_RENDERER;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Narrowing guard: did the dynamic import resolve a usable renderer? */
function hasMountRenderer(mod: unknown): mod is RendererModule {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    typeof (mod as { mountRenderer?: unknown }).mountRenderer === 'function'
  );
}

export interface MaybeMountRendererArgs {
  env: Record<string, string | undefined>;
  /**
   * Injectable import seam (testability). Defaults to the real dynamic
   * import of the optional dependency. Returns the module namespace.
   */
  importRenderer?: () => Promise<unknown>;
  /** Diagnostic sink for the one-line degrade notice. Defaults to stderr. */
  warn?: (line: string) => void;
}

/**
 * Decide and, if selected, mount the in-process renderer.
 *
 * Returns true ONLY when the renderer was actually mounted and has since
 * exited — in which case the caller skips both launch-fork branches and
 * exits cleanly. Returns false in every other case (selector unset, import
 * failed, module lacks `mountRenderer`), so the caller falls through to the
 * normal PTY/inherit launch.
 *
 * Defensive by design (§3 capability negotiation is launch-time only): a
 * missing or pre-`mountRenderer` renderer must not be fatal. On the
 * selected-but-unavailable path we emit ONE clear line and return false.
 */
export async function maybeMountRenderer(args: MaybeMountRendererArgs): Promise<boolean> {
  const { env } = args;
  if (!shouldUseRenderer(env)) return false;

  const importRenderer = args.importRenderer ?? (() => import('@fnclaude/renderer'));
  const warn = args.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  let mod: unknown;
  try {
    mod = await importRenderer();
  } catch {
    warn('fnc: renderer requested but @fnclaude/renderer is not installed; launching normally');
    return false;
  }

  if (!hasMountRenderer(mod)) {
    warn(
      'fnc: renderer requested but @fnclaude/renderer mountRenderer unavailable; launching normally',
    );
    return false;
  }

  // Bare session for this step: no args/model/MCP threaded into the
  // renderer yet (deferred — design.renderer.md §2). The renderer drives a
  // `claude --print` child via its own subscribeToClaude.
  const handle = mod.mountRenderer();
  await handle.waitUntilExit();
  return true;
}
