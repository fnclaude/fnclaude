import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { App } from "./App.tsx";
import { fixtureSession } from "./__fixtures__/events.ts";
import { mountRenderer } from "./mount.tsx";

/**
 * Verify `mountRenderer` renders `<App />` and adapts Ink's instance into
 * the documented `{ waitUntilExit, unmount }` handle — without mounting a
 * real TUI or letting `App` spawn a live `claude` subprocess.
 *
 * We inject a fake `renderFn` (a documented test seam) rather than mocking
 * the `ink` module: Bun's `mock.module` patches `ink` process-wide and
 * leaks into sibling renderer tests, breaking their real `render` calls.
 */

function fakeRender() {
  let captured: ReactElement | null = null;
  const unmount = mock(() => undefined);
  const waitUntilExit = mock(() => Promise.resolve());
  const renderFn = (node: ReactElement) => {
    captured = node;
    return { unmount, waitUntilExit };
  };
  return {
    renderFn,
    unmount,
    waitUntilExit,
    get captured() {
      return captured;
    },
  };
}

describe("mountRenderer", () => {
  test("renders <App /> and returns a { waitUntilExit, unmount } handle", () => {
    const ink = fakeRender();
    const handle = mountRenderer({ initialEvents: fixtureSession }, ink.renderFn);

    // It rendered the App component (not some other element).
    expect(ink.captured).not.toBeNull();
    expect((ink.captured as ReactElement).type).toBe(App);

    // The handle exposes exactly the documented surface.
    expect(typeof handle.waitUntilExit).toBe("function");
    expect(typeof handle.unmount).toBe("function");
  });

  test("forwards AppProps (initialEvents) through to App", () => {
    const ink = fakeRender();
    mountRenderer({ initialEvents: fixtureSession }, ink.renderFn);
    const props = (ink.captured as ReactElement).props as { initialEvents?: unknown };
    expect(props.initialEvents).toBe(fixtureSession);
  });

  test("handle delegates to the underlying Ink instance", async () => {
    const ink = fakeRender();
    const handle = mountRenderer({ initialEvents: [] }, ink.renderFn);

    handle.unmount();
    expect(ink.unmount).toHaveBeenCalledTimes(1);

    await handle.waitUntilExit();
    expect(ink.waitUntilExit).toHaveBeenCalledTimes(1);
  });

  test("defaults to no props (live mode) when called bare", () => {
    const ink = fakeRender();
    // Pass only the render seam; props default to {} → App self-subscribes.
    mountRenderer(undefined, ink.renderFn);
    expect(ink.captured).not.toBeNull();
    expect((ink.captured as ReactElement).type).toBe(App);
    const props = (ink.captured as ReactElement).props as { initialEvents?: unknown };
    expect(props.initialEvents).toBeUndefined();
  });
});
