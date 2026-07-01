/**
 * Interception tests for fnc-native `//` slash commands in the submit path.
 *
 * A submitted draft starting with `//` must be handed to the injected
 * `onSlash` and NEVER routed to claude via `sendUserTurn`. A single `/`
 * (`/compact`) and plain text must pass through to `sendUserTurn` unchanged.
 * These fail against the pre-feature App, which routed every non-empty draft
 * straight to `sendUserTurn`.
 */
import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SlashFeedback } from "./App.tsx";
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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function fakeSubscription() {
  let pushImpl: ((e: ClaudeEvent) => void) | null = null;
  const events: AsyncIterable<ClaudeEvent> = {
    [Symbol.asyncIterator]() {
      const queue: ClaudeEvent[] = [];
      const done = false;
      let wake: (() => void) | null = null;
      pushImpl = (e) => {
        queue.push(e);
        wake?.();
      };
      return {
        async next(): Promise<IteratorResult<ClaudeEvent>> {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (queue.length > 0) return { value: queue.shift() as ClaudeEvent, done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
  const sendUserTurn = mock((_text: string) => undefined);
  const interrupt = mock(() => undefined);
  const close = mock(() => Promise.resolve(0));
  const sub: ClaudeSubscription = { events, sendUserTurn, interrupt, close };
  return { sub, sendUserTurn, push: (e: ClaudeEvent) => pushImpl?.(e) };
}

function mount(onSlash?: (raw: string, sid: string | null) => SlashFeedback) {
  const fake = fakeSubscription();
  const slash = mock(onSlash ?? (() => ({ ok: true, message: "ok" })));
  let dispatch: ((input: string, key: Key) => void) | null = null;
  const instance = render(
    <App
      subscription={fake.sub}
      viewportHeight={1000}
      onSlash={slash}
      testInputBus={(handler) => {
        dispatch = handler;
      }}
    />,
  );
  return {
    send: (input: string, key: Key) =>
      (dispatch as unknown as (i: string, k: Key) => void)(input, key),
    sendUserTurn: fake.sendUserTurn,
    slash,
    push: fake.push,
    frame: () => instance.lastFrame() ?? "",
    unmount: () => instance.unmount(),
  };
}

function type(send: (i: string, k: Key) => void, text: string): void {
  // draftRef updates synchronously inside handleKey, so no per-char flush is
  // needed — typing all chars then submitting keeps the test fast + stable.
  for (const ch of text) send(ch, baseKey);
}

async function submit(send: (i: string, k: Key) => void, text: string): Promise<void> {
  type(send, text);
  send("", { ...baseKey, return: true });
  await flush();
}

describe("<App /> // slash interception", () => {
  test("//restart calls onSlash and NOT sendUserTurn", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "//restart");
    expect(app.slash).toHaveBeenCalledTimes(1);
    expect(app.slash.mock.calls[0]?.[0]).toBe("//restart");
    expect(app.sendUserTurn).not.toHaveBeenCalled();
    app.unmount();
  });

  test("//res (prefix) is intercepted, raw line passed through", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "//res");
    expect(app.slash).toHaveBeenCalledTimes(1);
    expect(app.slash.mock.calls[0]?.[0]).toBe("//res");
    expect(app.sendUserTurn).not.toHaveBeenCalled();
    app.unmount();
  });

  test("single-slash /compact passes through to sendUserTurn (not intercepted)", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "/compact");
    expect(app.slash).not.toHaveBeenCalled();
    expect(app.sendUserTurn).toHaveBeenCalledWith("/compact");
    app.unmount();
  });

  test("plain text routes to sendUserTurn", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "hello there");
    expect(app.slash).not.toHaveBeenCalled();
    expect(app.sendUserTurn).toHaveBeenCalledWith("hello there");
    app.unmount();
  });

  test("onSlash receives the session id captured from the init event", async () => {
    const app = mount();
    await flush();
    app.push({ type: "system", subtype: "init", session_id: "sess-xyz", uuid: "u1" });
    await flush();
    await submit(app.send, "//restart");
    expect(app.slash.mock.calls[0]?.[1]).toBe("sess-xyz");
    app.unmount();
  });

  test("feedback message is surfaced as a toast", async () => {
    const app = mount(() => ({ ok: false, message: "unknown fnc command: //nope" }));
    await flush();
    await submit(app.send, "//nope");
    await flush();
    expect(app.frame()).toContain("unknown fnc command: //nope");
    app.unmount();
  });
});
