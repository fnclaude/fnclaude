/**
 * Integration tests for the app-owned scroll viewport + token-burn POC.
 *
 * These fail against the pre-integration App (flat transcript, no viewport, no
 * Alt+u render):
 *   - "token-burn line renders only when usage present AND visible": the
 *     <TokenBurn> wiring inside AssistantRender didn't exist.
 *   - "Alt+u toggles the token-burn line": the keybind + element didn't render.
 *   - "input stays visible when the transcript overflows": the input was nested
 *     in the transcript Box, so a tall transcript would not clip independently.
 *   - "Alt+u above the fold keeps the visible top line invariant": no scroll
 *     state / anchoring existed.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { fixtureAssistantWithUsage } from "./__fixtures__/events.ts";
import type { Key } from "./keybinds.ts";
import type { AssistantEvent, ClaudeEvent } from "./types/events.ts";

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

/** A single-line assistant message with a locatable marker. */
function lineMsg(i: number, usage?: AssistantEvent["message"]["usage"]): ClaudeEvent {
  return {
    type: "assistant",
    session_id: "scroll-session",
    uuid: `u-asst-${i}`,
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: `MESSAGE-${i}` }],
      ...(usage ? { usage } : {}),
    },
  };
}

/** The topmost transcript line carrying a MESSAGE-N marker. */
function topMessageLine(frame: string): string | undefined {
  return frame.split("\n").find((l) => l.includes("MESSAGE-"));
}

describe("<App /> token-burn POC (Alt+u)", () => {
  test("token-burn line is hidden under the normal preset by default", async () => {
    const instance = render(
      <App initialEvents={[fixtureAssistantWithUsage]} viewportHeight={1000} />,
    );
    await flush();
    const frame = instance.lastFrame() ?? "";
    // The assistant text shows; the usage one-liner does not (hidden in normal).
    expect(frame).toContain("Answer with usage.");
    expect(frame).not.toContain("1.5k in");
    instance.unmount();
  });

  test("Alt+u reveals the per-turn token-burn line", async () => {
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        initialEvents={[fixtureAssistantWithUsage]}
        viewportHeight={1000}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    expect(instance.lastFrame() ?? "").not.toContain("1.5k in");
    expect(dispatch).not.toBeNull();

    (dispatch as unknown as (i: string, k: Key) => void)("u", { ...baseKey, meta: true });
    await flush();

    const after = instance.lastFrame() ?? "";
    expect(after).toContain("1.5k in");
    expect(after).toContain("320 out");
    // Cache section present (fixture has cache fields).
    expect(after).toContain("cache");
    expect(after).toContain("1 override");
    instance.unmount();
  });

  test("no token-burn line when the assistant event carries no usage", async () => {
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const instance = render(
      <App
        initialEvents={[lineMsg(0)]}
        viewportHeight={1000}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    // Even after revealing token-burn, an event without usage shows nothing.
    (dispatch as unknown as (i: string, k: Key) => void)("u", { ...baseKey, meta: true });
    await flush();
    expect(instance.lastFrame() ?? "").not.toContain(" in  ↓");
    instance.unmount();
  });
});

describe("<App /> app-owned scroll viewport", () => {
  test("input prompt stays visible when the transcript overflows the viewport", async () => {
    const events = Array.from({ length: 20 }, (_, i) => lineMsg(i));
    // Tiny viewport so the transcript clips; the input is a separate top-level
    // control and must NOT be clipped away with it.
    const instance = render(<App initialEvents={events} viewportHeight={3} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    // Following by default → pinned to the bottom: last message visible.
    expect(frame).toContain("MESSAGE-19");
    // The viewport clips: the first message is scrolled out of view.
    expect(frame).not.toContain("MESSAGE-0\n");
    // The input control survives independently of the clipped transcript.
    expect(frame).toContain("type a message and press Enter");
    instance.unmount();
  });

  test("toggling a token-burn block above the fold keeps the top line invariant", async () => {
    // 30 single-line messages; the FIRST carries usage so toggling Alt+u grows
    // a row far above the fold once we scroll up.
    const events: ClaudeEvent[] = [
      lineMsg(0, {
        input_tokens: 1500,
        output_tokens: 320,
        cache_read_input_tokens: 4096,
      }),
      ...Array.from({ length: 29 }, (_, i) => lineMsg(i + 1)),
    ];
    let dispatch: ((input: string, key: Key) => void) | null = null;
    // viewportHeight 3 → page size 2, which matches the per-message row height
    // (text + trailing blank) so Home + PageDown land the fold on clean message
    // boundaries — the anchoring invariant is then exact, not off-by-a-subrow.
    const instance = render(
      <App
        initialEvents={events}
        viewportHeight={3}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;

    // Jump to the top (releases follow), then page down to a clean boundary that
    // leaves MESSAGE-0 well above the fold.
    send("", { ...baseKey, home: true });
    await flush();
    for (let i = 0; i < 5; i++) {
      send("", { ...baseKey, pageDown: true });
      await flush();
    }
    await flush();

    const before = topMessageLine(instance.lastFrame() ?? "");
    expect(before).toBeDefined();
    // We are NOT pinned to the bottom: the last message is out of view.
    expect(instance.lastFrame() ?? "").not.toContain("MESSAGE-29");

    // Toggle the token-burn block on MESSAGE-0 (above the fold) — the anchored
    // reanchor must keep the visible top line exactly where it was.
    send("u", { ...baseKey, meta: true });
    await flush();
    await flush();

    const after = topMessageLine(instance.lastFrame() ?? "");
    expect(after).toBe(before);
    instance.unmount();
  });
});
