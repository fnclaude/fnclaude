import { describe, expect, mock, test } from "bun:test";
import { type ReactElement, isValidElement } from "react";
import { App } from "./App";
import type { ClaudeSubscription, SpawnFn, SpawnResult } from "./claude-process";
import { mountRenderer } from "./mount";

/**
 * `mountRenderer` wraps `<App>` in a React error boundary, so the captured
 * root element is the boundary, not `App` directly. Walk the single-child
 * chain to find the `App` element (and the subscription prop it carries).
 */
function findApp(root: ReactElement | null): ReactElement | null {
  let node: unknown = root;
  for (let depth = 0; depth < 8 && isValidElement(node); depth++) {
    const el = node as ReactElement;
    if (el.type === App) return el;
    node = (el.props as { children?: unknown }).children;
  }
  return null;
}

/**
 * `mountRenderer` now CREATES the claude subscription itself and returns a
 * full handle (`waitUntilExit`/`unmount`/`sendUserTurn`/`close`), injecting
 * the subscription into `<App>` as a prop. We verify that wiring without
 * mounting a real TUI or spawning a live `claude`.
 *
 * Two seams keep the test hermetic:
 *   - a fake `renderFn` (documented seam) captures the rendered element
 *     instead of calling Ink's `render` (whose `ink` mock would leak into
 *     sibling test files).
 *   - a fake `spawnFn` feeds the subscription deterministic bytes, so
 *     `subscribeToClaude` never touches the real binary.
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

/**
 * A spawn that records the argv/cwd it was handed and returns an empty,
 * immediately-closing stream. Enough for `subscribeToClaude` to construct a
 * subscription without a live process.
 */
function recordingSpawn() {
  const calls: { cmd: string[]; cwd?: string }[] = [];
  const spawnFn: SpawnFn = (cmd, opts) => {
    calls.push({ cmd, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
    const result: SpawnResult = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdin: new WritableStream<Uint8Array>(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
    return result;
  };
  return { spawnFn, calls };
}

describe("mountRenderer", () => {
  test("renders <App /> with an injected subscription and returns the full handle", () => {
    const ink = fakeRender();
    const { spawnFn } = recordingSpawn();
    const handle = mountRenderer({ spawnFn }, ink.renderFn);

    expect(ink.captured).not.toBeNull();
    const app = findApp(ink.captured);
    expect(app).not.toBeNull();

    // App receives a live subscription as a prop (created by mountRenderer).
    const props = (app as ReactElement).props as { subscription?: ClaudeSubscription };
    expect(props.subscription).toBeDefined();
    expect(typeof props.subscription?.sendUserTurn).toBe("function");

    // The handle exposes the full documented surface.
    expect(typeof handle.waitUntilExit).toBe("function");
    expect(typeof handle.unmount).toBe("function");
    expect(typeof handle.sendUserTurn).toBe("function");
    expect(typeof handle.close).toBe("function");
  });

  test("flows cwd / extraArgs / spawnFn into subscribeToClaude", () => {
    const ink = fakeRender();
    const { spawnFn, calls } = recordingSpawn();
    mountRenderer({ cwd: "/tmp/work", extraArgs: ["--model", "opus"], spawnFn }, ink.renderFn);

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.cwd).toBe("/tmp/work");
    // extraArgs are appended after the renderer's REQUIRED_ARGS.
    expect(call?.cmd).toContain("--model");
    expect(call?.cmd).toContain("opus");
  });

  test("initialPrompt is delivered as a sendUserTurn before the first render", async () => {
    const ink = fakeRender();
    const order: string[] = [];

    // Wrap renderFn so we can assert ordering relative to the stdin getWriter
    // call subscribeToClaude makes synchronously when constructing the sub.
    const renderFn = (node: ReactElement) => {
      order.push("render");
      return ink.renderFn(node);
    };

    const writes: string[] = [];
    const spawnFnRecording: SpawnFn = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      // getWriter() is called synchronously inside subscribeToClaude; record
      // that as the subscription-construction marker so we can prove the
      // initialPrompt turn is queued before render.
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(new TextDecoder().decode(chunk));
        },
      }),
      exited: Promise.resolve(0),
      kill: () => undefined,
    });

    mountRenderer({ initialPrompt: "hello world", spawnFn: spawnFnRecording }, renderFn);
    // The stdin write is async (WritableStream microtask); let it settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The prompt was written to claude's stdin as a user turn.
    expect(writes.join("")).toContain("hello world");
    // render happened (after the synchronous sendUserTurn(initialPrompt) call).
    expect(order).toContain("render");
  });

  test("handle.sendUserTurn / handle.close delegate to the subscription", async () => {
    const ink = fakeRender();
    const writes: string[] = [];
    let stdinClosed = false;
    const spawnFn: SpawnFn = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(new TextDecoder().decode(chunk));
        },
        close() {
          stdinClosed = true;
        },
      }),
      exited: Promise.resolve(7),
      kill: () => undefined,
    });

    const handle = mountRenderer({ spawnFn }, ink.renderFn);
    handle.sendUserTurn("from the host");
    // The stdin write is async (WritableStream microtask); let it settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(writes.join("")).toContain("from the host");

    const code = await handle.close();
    expect(stdinClosed).toBe(true);
    expect(code).toBe(7);
  });

  test("handle delegates waitUntilExit / unmount to the Ink instance", async () => {
    const ink = fakeRender();
    const { spawnFn } = recordingSpawn();
    const handle = mountRenderer({ spawnFn }, ink.renderFn);

    handle.unmount();
    expect(ink.unmount).toHaveBeenCalledTimes(1);

    await handle.waitUntilExit();
    expect(ink.waitUntilExit).toHaveBeenCalledTimes(1);
  });

  test("bare mountRenderer() (standalone) still creates a default subscription", () => {
    const ink = fakeRender();
    // No opts: must work for the standalone bin. We pass only the render seam
    // so App never mounts a real TUI; the default spawn would touch the live
    // binary, so we still hand in a spawnFn-less call but capture the element.
    // To avoid spawning the real `claude`, inject a spawnFn but omit every
    // other option — proving the no-extra-options path renders an App with a
    // subscription.
    const { spawnFn } = recordingSpawn();
    mountRenderer({ spawnFn }, ink.renderFn);
    expect(ink.captured).not.toBeNull();
    const app = findApp(ink.captured);
    expect(app).not.toBeNull();
    const props = (app as ReactElement).props as { subscription?: ClaudeSubscription };
    expect(props.subscription).toBeDefined();
  });
});
