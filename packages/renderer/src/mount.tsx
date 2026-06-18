/**
 * Library entry point. `mountRenderer` mounts the `App` into Ink and hands
 * back a handle so a host process (fnc) can drive the renderer in-process —
 * the same code path the standalone bin (`index.tsx`) takes.
 *
 * This module is import-safe: importing it has NO side effects (no top-level
 * `render()`), so `import("@fnclaude/renderer")` can resolve to a real
 * library without spawning a TUI. See docs/design.renderer.md §7.
 */

import { type Instance, render } from "ink";
import type { ReactElement } from "react";
import { App, type AppProps } from "./App.tsx";

export type { AppProps } from "./App.tsx";

/**
 * Handle returned by {@link mountRenderer}. Mirrors the subset of Ink's
 * `Instance` a host needs to await teardown or unmount imperatively.
 */
export interface RendererHandle {
  /** Resolves when the Ink app unmounts (Ctrl+C, `unmount()`, or exit). */
  waitUntilExit(): Promise<void>;
  /** Tear the Ink app down immediately. */
  unmount(): void;
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
 * Render `<App />` via Ink and return a handle to it.
 *
 * Called with no props in production (by the bin), the App self-subscribes
 * to a live `claude --print` stream-json session exactly as before. Pass
 * `{ initialEvents }` to seed a static log without a subprocess (tests do
 * this); `{ testInputBus }` to drive input deterministically.
 */
export function mountRenderer(props: AppProps = {}, renderFn: RenderFn = render): RendererHandle {
  const instance = renderFn(<App {...props} />);
  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
