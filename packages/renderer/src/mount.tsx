/**
 * Library entry point. `mountRenderer` OWNS the `claude` subscription:
 * it creates the stream-json session, hands the subscription into `<App>`
 * as a prop, and returns a handle so a host process (fnc) can drive the
 * renderer in-process — send turns, await teardown, and reap claude's exit
 * code. The standalone bin (`index.tsx`) takes the same path and simply
 * ignores the returned handle.
 *
 * Lifting subscription creation out of `App` (it used to self-subscribe in a
 * `useEffect`) is what lets fnc reach `sendUserTurn`/`close` — see
 * docs/design.renderer.md §7 and /tmp/renderer-parity/spawn-args.md §(c).
 *
 * This module is import-safe: importing it has NO side effects (no top-level
 * `render()`), so `import("@fnclaude/renderer")` can resolve to a real
 * library without spawning a TUI.
 */

import { type Instance, render } from "ink";
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { App } from "./App.tsx";
import { type ClaudeSubscription, type SpawnFn, subscribeToClaude } from "./claude-process.ts";

export type { AppProps } from "./App.tsx";
export type { ClaudeSubscription, SpawnFn } from "./claude-process.ts";

/**
 * Options for {@link mountRenderer}. All optional: called bare (the
 * standalone bin) it spawns a default `claude` session in `process.cwd()`.
 */
export interface MountOptions {
  /** Working dir for the claude child. fnc passes its resolved launch cwd. */
  cwd?: string;
  /**
   * CLAUDE-native args threaded into the spawn after the renderer's required
   * flags (`--model`/`--effort`/`--resume`/`--append-system-prompt`/the
   * self-MCP `--mcp-config`). See spawn-args.md §(a).
   */
  extraArgs?: string[];
  /**
   * fnc-built spawn baking in the resolved `claude` binary, composed child
   * env, and piped stderr. Omit → the default spawn (standalone bin).
   */
  spawnFn?: SpawnFn;
  /**
   * Delivered as the first `sendUserTurn` after the subscription is created
   * and BEFORE the first render — the stream-json first turn (and the
   * ultracode `/effort` seed). See spawn-args.md §(a)/§(c).
   */
  initialPrompt?: string;
}

/**
 * Handle returned by {@link mountRenderer}. `waitUntilExit`/`unmount` mirror
 * the subset of Ink's `Instance` a host needs; `sendUserTurn`/`close` expose
 * the subscription so fnc can drive turns and reap claude's exit code (the
 * renderer-mount equivalent of `proc.exited`).
 */
export interface RendererHandle {
  /** Resolves when the Ink app unmounts (Ctrl+C, `unmount()`, or exit). */
  waitUntilExit(): Promise<void>;
  /** Tear the Ink app down immediately. */
  unmount(): void;
  /** Send a user turn to claude over the subscription's stdin pipe. */
  sendUserTurn(text: string): void;
  /** Close claude's stdin (EOF) and resolve with its exit code. */
  close(): Promise<number>;
}

/**
 * Test seam: a stand-in for Ink's `render`. Production callers never pass
 * this — the bin and fnc both rely on the default. Injecting it lets tests
 * capture the rendered element and supply a fake instance WITHOUT
 * `mock.module`, whose `ink` replacement leaks process-wide into sibling
 * test files. Mirrors `App`'s own injection seams (`testInputBus`).
 */
export type RenderFn = (node: ReactElement) => Pick<Instance, "waitUntilExit" | "unmount">;

/**
 * React error boundary so a render-time throw in the transcript tree is
 * caught and surfaced as a single line instead of crashing the host fnc
 * process (combined-mode crash-domain mitigation — design.renderer.md §6).
 */
class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Best-effort diagnostic to the file logger (never the TTY — Ink owns it).
    // No logger is wired here yet; keep the throw contained and visible.
    void info;
    void error;
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <App
          initialEvents={[
            {
              type: "parse_error",
              raw: `renderer crashed: ${this.state.error.message}`,
            },
          ]}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Create the claude subscription, render `<App />` consuming it, and return a
 * handle. With no options (standalone bin) the subscription uses the default
 * spawn and `process.cwd()`. With an `initialPrompt`, the first user turn is
 * delivered before the first render. `<App>` is wrapped in an error boundary
 * + a top-level guard so a render throw cannot crash the host process.
 */
export function mountRenderer(
  opts: MountOptions = {},
  renderFn: RenderFn = render,
): RendererHandle {
  const sub: ClaudeSubscription = subscribeToClaude({
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
    ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
  });

  if (opts.initialPrompt) sub.sendUserTurn(opts.initialPrompt);

  const instance = guardedRender(renderFn, sub);

  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
    sendUserTurn: sub.sendUserTurn,
    close: sub.close,
  };
}

/**
 * Render with both layers of crash containment: the React error boundary
 * (render-time throws inside the tree) and a synchronous try/catch around the
 * `renderFn` call itself (a throw before React mounts). If the initial render
 * throws, return an inert handle so the host can still exit cleanly.
 */
function guardedRender(
  renderFn: RenderFn,
  sub: ClaudeSubscription,
): Pick<Instance, "waitUntilExit" | "unmount"> {
  try {
    return renderFn(
      <RenderErrorBoundary>
        <App subscription={sub} />
      </RenderErrorBoundary>,
    );
  } catch {
    return {
      waitUntilExit: () => Promise.resolve(),
      unmount: () => undefined,
    };
  }
}
