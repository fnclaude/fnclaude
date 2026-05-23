import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { fixtureSession } from "./__fixtures__/events.ts";
import type { Key } from "./keybinds.ts";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

/**
 * Small helper: tick a few times so async useEffect / fixture ingestion
 * settle before asserting frame content. ink-testing-library doesn't
 * expose a "wait" helper — yielding the microtask queue is sufficient
 * because our fixture iterator only awaits Promise.resolve().
 */
async function flush(): Promise<void> {
  // Both microtask drain (for our awaited fixture iterator) and a real
  // macrotask tick (for React's useEffect commit phase under
  // ink-testing-library). Microtask-only flushing isn't sufficient — the
  // testInputBus callback only fires after the effect commits.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("<App />", () => {
  test("renders initial status line with normal preset", async () => {
    const instance = render(<App initialEvents={[]} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("preset: normal");
    instance.unmount();
  });

  test("ingests events and shows Bash command (input is `show` in normal)", async () => {
    const instance = render(<App initialEvents={fixtureSession} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    // Bash.input default in `normal` is `show` — slice C's BashInput
    // renders the command with a "$ " prefix.
    expect(frame).toContain("$ ls -la");
    // Assistant text is always shown.
    expect(frame).toContain("Listing files now.");
    instance.unmount();
  });

  test("Bash.output is hidden under the `normal` preset by default", async () => {
    const instance = render(<App initialEvents={fixtureSession} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    // Bash.output default in `normal` is `hide` — BashOutput renders null.
    expect(frame).not.toContain("total 0");
    instance.unmount();
  });

  test("Alt+3 toggles Bash.output → repaints past content into view", async () => {
    // Inject a fake-input handler so the test can drive useInput
    // deterministically without depending on stdin TTY behaviour.
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        initialEvents={fixtureSession}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    // Sanity: hidden before toggle.
    expect(instance.lastFrame() ?? "").not.toContain("total 0");
    expect(dispatch).not.toBeNull();

    // Simulate Alt+3 → toggle Bash.output (was `hide` in `normal`,
    // override flips to `show`).
    (dispatch as unknown as (i: string, k: Key) => void)("3", {
      ...baseKey,
      meta: true,
    });
    await flush();

    const after = instance.lastFrame() ?? "";
    // Repaint: past Bash output content now visible.
    expect(after).toContain("total 0");
    // Override count surfaces in the status line.
    expect(after).toContain("1 override");
    instance.unmount();
  });

  test("Alt+0 cycles preset forward and clears overrides", async () => {
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        initialEvents={fixtureSession}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    expect(dispatch).not.toBeNull();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    // Set an override first via Alt+3.
    send("3", { ...baseKey, meta: true });
    await flush();
    expect(instance.lastFrame() ?? "").toContain("1 override");

    // Cycle: normal → verbose.
    send("0", { ...baseKey, meta: true });
    await flush();
    const after = instance.lastFrame() ?? "";
    expect(after).toContain("preset: verbose");
    // Overrides cleared.
    expect(after).not.toContain("1 override");
    instance.unmount();
  });
});
