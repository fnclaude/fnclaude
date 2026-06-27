import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { fixtureSession } from "./__fixtures__/events.ts";
import type { ClaudeSubscription } from "./claude-process.ts";
import type { Key } from "./keybinds.ts";
import type { ClaudeEvent } from "./types/events.ts";

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

/**
 * A controllable fake `ClaudeSubscription`: `push` feeds the async-iterable
 * `events`, `endStream` closes it, and `sendUserTurn`/`close` are spies so
 * tests can assert App's interaction with the injected subscription without a
 * subprocess. App now CONSUMES the subscription (it no longer creates one),
 * so this stands in for what `mountRenderer` would inject.
 */
function fakeSubscription() {
  let pushImpl: ((e: ClaudeEvent) => void) | null = null;
  let endImpl: (() => void) | null = null;
  const events: AsyncIterable<ClaudeEvent> = {
    [Symbol.asyncIterator]() {
      const queue: ClaudeEvent[] = [];
      let done = false;
      let wake: (() => void) | null = null;
      pushImpl = (e) => {
        queue.push(e);
        wake?.();
      };
      endImpl = () => {
        done = true;
        wake?.();
      };
      return {
        async next(): Promise<IteratorResult<ClaudeEvent>> {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (queue.length > 0) {
            return { value: queue.shift() as ClaudeEvent, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
  const sendUserTurn = mock((_text: string) => undefined);
  const close = mock(() => Promise.resolve(0));
  const sub: ClaudeSubscription = { events, sendUserTurn, close };
  return {
    sub,
    sendUserTurn,
    close,
    push: (e: ClaudeEvent) => pushImpl?.(e),
    endStream: () => endImpl?.(),
  };
}

describe("<App />", () => {
  test("renders initial status line with normal preset", async () => {
    const instance = render(<App initialEvents={[]} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("preset: normal");
    instance.unmount();
  });

  test("renders the input prompt even with an empty draft (bare session)", async () => {
    // Regression: a bare session (no draft typed, no events) used to render
    // the prompt line as `null`, leaving just the status line over a blank
    // screen — the session looked dead. The prompt marker must always show.
    const instance = render(<App initialEvents={[]} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("> ");
    expect(frame).toContain("type a message and press Enter");
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

describe("<App /> injected subscription", () => {
  test("consumes events from props.subscription and renders them live", async () => {
    const fake = fakeSubscription();
    const instance = render(<App subscription={fake.sub} />);
    await flush();

    fake.push({
      type: "assistant",
      session_id: "s",
      uuid: "a1",
      message: {
        id: "m1",
        model: "claude-opus-4-8",
        role: "assistant",
        content: [{ type: "text", text: "streamed answer" }],
      },
    });
    await flush();

    expect(instance.lastFrame() ?? "").toContain("streamed answer");
    instance.unmount();
  });

  test("Enter routes a draft to the injected subscription's sendUserTurn", async () => {
    const fake = fakeSubscription();
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        subscription={fake.sub}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    send("h", { ...baseKey });
    send("i", { ...baseKey });
    await flush();
    send("", { ...baseKey, return: true });
    await flush();

    expect(fake.sendUserTurn).toHaveBeenCalledTimes(1);
    expect(fake.sendUserTurn).toHaveBeenCalledWith("hi");
    instance.unmount();
  });

  test("Enter appends the typed prompt to the transcript with a › marker", async () => {
    const fake = fakeSubscription();
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        subscription={fake.sub}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    send("h", { ...baseKey });
    send("i", { ...baseKey });
    await flush();
    send("", { ...baseKey, return: true });
    await flush();

    const frame = instance.lastFrame() ?? "";
    // The submitted prompt is now visible in the transcript (claude does not
    // echo user turns back), prefixed with the native-style › marker. The body
    // routes through MarkdownRenderer, so the marker and text are separate
    // nodes rather than one contiguous string.
    expect(frame).toContain("›");
    expect(frame).toContain("hi");
    // And it routed to the subscription.
    expect(fake.sendUserTurn).toHaveBeenCalledWith("hi");
    instance.unmount();
  });

  test("renders a submitted prompt as markdown (no literal ** for bold)", async () => {
    const fake = fakeSubscription();
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        subscription={fake.sub}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    for (const ch of "**bold**") send(ch, { ...baseKey });
    await flush();
    send("", { ...baseKey, return: true });
    await flush();

    const frame = instance.lastFrame() ?? "";
    // The body is markdown-rendered (same MarkdownRenderer as assistant text),
    // so the ** syntax is consumed — the transcript shows styled text, never
    // the literal markers.
    expect(frame).toContain("bold");
    expect(frame).not.toContain("**");
    // The raw markdown is still what's sent to claude.
    expect(fake.sendUserTurn).toHaveBeenCalledWith("**bold**");
    instance.unmount();
  });

  test("Shift+Enter inserts a newline instead of submitting", async () => {
    const fake = fakeSubscription();
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        subscription={fake.sub}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    send("a", { ...baseKey });
    // Shift+Enter: newline into the draft, NOT a submit.
    send("", { ...baseKey, return: true, shift: true });
    await flush();
    expect(fake.sendUserTurn).not.toHaveBeenCalled();

    send("b", { ...baseKey });
    // Plain Enter submits the whole multi-line draft.
    send("", { ...baseKey, return: true });
    await flush();
    expect(fake.sendUserTurn).toHaveBeenCalledWith("a\nb");
    instance.unmount();
  });

  test("Backslash+Enter inserts a newline (line continuation) instead of submitting", async () => {
    const fake = fakeSubscription();
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        subscription={fake.sub}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    send("a", { ...baseKey });
    send("\\", { ...baseKey });
    // A trailing backslash turns Enter into a line break (terminal-agnostic
    // fallback for shift+enter); the backslash itself is consumed.
    send("", { ...baseKey, return: true });
    await flush();
    expect(fake.sendUserTurn).not.toHaveBeenCalled();

    send("b", { ...baseKey });
    send("", { ...baseKey, return: true });
    await flush();
    expect(fake.sendUserTurn).toHaveBeenCalledWith("a\nb");
    instance.unmount();
  });

  test("does NOT close the subscription on unmount (handle owns close)", async () => {
    const fake = fakeSubscription();
    const instance = render(<App subscription={fake.sub} />);
    await flush();
    instance.unmount();
    await flush();
    expect(fake.close).not.toHaveBeenCalled();
  });

  test("closeStdin keybind still sends EOF via subscription.close", async () => {
    const fake = fakeSubscription();
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        subscription={fake.sub}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    // Ctrl+D → closeStdin action (sends EOF to claude via subscription.close).
    send("d", { ...baseKey, ctrl: true });
    await flush();

    expect(fake.close).toHaveBeenCalled();
    instance.unmount();
  });

  test("static mode (no subscription) renders initialEvents without a live stream", async () => {
    const instance = render(<App initialEvents={fixtureSession} />);
    await flush();
    expect(instance.lastFrame() ?? "").toContain("Listing files now.");
    instance.unmount();
  });
});
