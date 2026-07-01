/**
 * Integration tests for shell-style prompt-history recall in the input box.
 *
 * Up recalls the previous submitted prompt; repeated Up walks older. Down walks
 * back toward the newest, and Down past the newest restores the in-progress
 * draft the user had typed before navigation began. These fail against the
 * pre-feature App, which had no Up/Down handling at all.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function mount(): {
  send: (input: string, key: Key) => void;
  frame: () => string;
  unmount: () => void;
} {
  let dispatch: ((input: string, key: Key) => void) | null = null;
  const instance = render(
    <App
      viewportHeight={1000}
      testInputBus={(handler) => {
        dispatch = handler;
      }}
    />,
  );
  return {
    send: (input, key) => (dispatch as unknown as (i: string, k: Key) => void)(input, key),
    frame: () => instance.lastFrame() ?? "",
    unmount: () => instance.unmount(),
  };
}

/** Type each char then press Enter, awaiting a flush between keystrokes. */
async function submit(send: (i: string, k: Key) => void, text: string): Promise<void> {
  await type(send, text);
  send("", { ...baseKey, return: true });
  await flush();
}

async function type(send: (i: string, k: Key) => void, text: string): Promise<void> {
  for (const ch of text) {
    send(ch, baseKey);
    await flush();
  }
}

/**
 * The live-input draft line, isolated from the committed transcript. Both the
 * draft and submitted prompts now share the bold `›` marker, so the draft is
 * discriminated by the box border: the input line is the row carrying both a
 * `│` border glyph and the `›` marker. ANSI is stripped so the marker and
 * recalled text (separate styled nodes) read as one string.
 */
function draftLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("│") && line.includes("›")) ?? "";
}

describe("<App /> prompt history recall", () => {
  test("Up recalls the most recent submitted prompt", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "alpha");
    await submit(app.send, "beta");

    app.send("", { ...baseKey, upArrow: true });
    await flush();
    expect(draftLine(app.frame())).toContain("beta");
    app.unmount();
  });

  test("repeated Up walks to older prompts", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "alpha");
    await submit(app.send, "beta");

    app.send("", { ...baseKey, upArrow: true });
    await flush();
    app.send("", { ...baseKey, upArrow: true });
    await flush();
    expect(draftLine(app.frame())).toContain("alpha");
    app.unmount();
  });

  test("Down walks back toward the live draft", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "alpha");
    await submit(app.send, "beta");

    app.send("", { ...baseKey, upArrow: true });
    await flush();
    app.send("", { ...baseKey, upArrow: true });
    await flush();
    expect(draftLine(app.frame())).toContain("alpha");

    app.send("", { ...baseKey, downArrow: true });
    await flush();
    expect(draftLine(app.frame())).toContain("beta");

    app.send("", { ...baseKey, downArrow: true });
    await flush();
    // Past the newest → the live (empty) draft is restored: placeholder shows.
    expect(draftLine(app.frame())).toContain("type a message and press Enter");
    app.unmount();
  });

  test("Up stashes an in-progress draft, Down restores it", async () => {
    const app = mount();
    await flush();
    await submit(app.send, "alpha");
    await type(app.send, "wip");
    expect(draftLine(app.frame())).toContain("wip");

    app.send("", { ...baseKey, upArrow: true });
    await flush();
    expect(draftLine(app.frame())).toContain("alpha");

    app.send("", { ...baseKey, downArrow: true });
    await flush();
    expect(draftLine(app.frame())).toContain("wip");
    app.unmount();
  });
});
