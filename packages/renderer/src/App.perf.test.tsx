import { describe, expect, spyOn, test } from "bun:test";
import { render } from "ink-testing-library";
import { marked } from "marked";
import { App } from "./App.tsx";
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
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Build N committed assistant messages, each carrying markdown text. */
function markdownEvents(n: number): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({
      type: "assistant",
      session_id: "perf-session",
      uuid: `u-asst-${i}`,
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          {
            type: "text",
            text: `## Heading ${i}\n\nSome **bold** and _italic_ text with \`code\` span number ${i}.`,
          },
        ],
      },
    });
  }
  return events;
}

describe("<App /> markdown parse memoization", () => {
  test("a keystroke triggers ZERO new marked.lexer calls", async () => {
    const lexerSpy = spyOn(marked, "lexer");
    try {
      const messageCount = 5;
      let dispatch: ((input: string, key: Key) => void) | null = null;
      const instance = render(
        <App
          initialEvents={markdownEvents(messageCount)}
          testInputBus={(handler) => {
            dispatch = handler;
          }}
        />,
      );
      await flush();

      // Sanity: the seeded markdown actually went through the lexer at least
      // once per committed message during the initial render.
      expect(lexerSpy.mock.calls.length).toBeGreaterThanOrEqual(messageCount);
      expect(dispatch).not.toBeNull();
      const send = dispatch as unknown as (i: string, k: Key) => void;

      const before = lexerSpy.mock.calls.length;
      // One printable keystroke into the draft input.
      send("x", { ...baseKey });
      await flush();
      const after = lexerSpy.mock.calls.length;

      const delta = after - before;
      // The keystroke only mutates the draft; already-committed transcript
      // markdown must not be re-lexed. With memoization the delta is bounded
      // and independent of message count — it must NOT scale with the
      // transcript length.
      expect(delta).toBeLessThan(messageCount);
      // Stronger: a keystroke re-lexes nothing already on screen.
      expect(delta).toBe(0);

      instance.unmount();
    } finally {
      lexerSpy.mockRestore();
    }
  });

  test("per-keystroke lexer cost does not scale with transcript length", async () => {
    function deltaForCount(n: number): Promise<number> {
      return (async () => {
        const lexerSpy = spyOn(marked, "lexer");
        try {
          let dispatch: ((input: string, key: Key) => void) | null = null;
          const instance = render(
            <App
              initialEvents={markdownEvents(n)}
              testInputBus={(handler) => {
                dispatch = handler;
              }}
            />,
          );
          await flush();
          const send = dispatch as unknown as (i: string, k: Key) => void;
          const before = lexerSpy.mock.calls.length;
          send("y", { ...baseKey });
          await flush();
          const after = lexerSpy.mock.calls.length;
          instance.unmount();
          return after - before;
        } finally {
          lexerSpy.mockRestore();
        }
      })();
    }

    const small = await deltaForCount(2);
    const large = await deltaForCount(10);
    // Flat per-keystroke cost: 5x the messages must not mean ~5x the lexing.
    expect(large).toBe(small);
  });
});
