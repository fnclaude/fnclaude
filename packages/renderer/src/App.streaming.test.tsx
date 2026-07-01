/**
 * Faithful-rendering + token-streaming tests for <App />.
 *
 * Every test here fails against the pre-streaming tree:
 *   - duplicate-answer: result.result re-printed under the final assistant text
 *   - system/init, system/status, rate_limit_event: dropped (returned null)
 *   - unknown top-level event: dropped (final `return null`)
 *   - live streaming preview + finalize-on-assistant: no reducer wired
 *   - markdown: live preview + committed text both render natively (no glow)
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type StreamFeed } from "./App";
import { assistantMsg1Text, assistantMsg1Tool, streamMsg1 } from "./__fixtures__/stream-events";
import type { Key } from "./keybinds";
import type { ClaudeEvent } from "./types/events";

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

describe("<App /> faithful rendering", () => {
  test("does not print the final answer twice (result vs assistant text)", async () => {
    const answer = "The answer is 42.";
    const events: ClaudeEvent[] = [
      {
        type: "assistant",
        session_id: "s",
        uuid: "a1",
        message: {
          id: "m1",
          model: "claude-opus-4-8",
          role: "assistant",
          content: [{ type: "text", text: answer }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s",
        uuid: "r1",
        result: answer, // verbatim copy of the assistant text — claude does this
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
      },
    ];
    const instance = render(<App initialEvents={events} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    // The answer string must appear exactly once across the transcript.
    const occurrences = frame.split(answer).length - 1;
    expect(occurrences).toBe(1);
    instance.unmount();
  });

  test("hides the system/init session header by default (meta noise)", async () => {
    const events: ClaudeEvent[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-xyz",
        uuid: "u1",
        cwd: "/tmp/work",
        model: "claude-opus-4-8",
      },
    ];
    const instance = render(<App initialEvents={events} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    // The session header is meta noise — hidden under the normal preset.
    expect(frame).not.toContain("sess-xyz");
    expect(frame).not.toContain("session=");
    instance.unmount();
  });

  test("renders system/status working indicator", async () => {
    const events: ClaudeEvent[] = [
      {
        type: "system",
        subtype: "status",
        session_id: "s",
        uuid: "u2",
        status: "requesting",
      },
    ];
    const instance = render(<App initialEvents={events} />);
    await flush();
    expect(instance.lastFrame() ?? "").toContain("requesting");
    instance.unmount();
  });

  test("does NOT commit a transient system/status event into the transcript", async () => {
    // A live `status` ("requesting") is a momentary inter-turn affordance, not
    // transcript content. Ingest must drop it so it never becomes a permanent
    // `◌ requesting…` line. Pre-change ingest appended it and the transcript
    // rendered it forever, even after real content arrived.
    let push!: (e: ClaudeEvent) => void;
    const feed: StreamFeed = (emit) => {
      push = emit.push;
      return () => undefined;
    };
    const instance = render(<App streamFeed={feed} />);
    await flush();

    push({ type: "system", subtype: "status", session_id: "s", uuid: "u1", status: "requesting" });
    await flush();
    // A subsequent real event lands — the status must still not be present.
    push({
      type: "assistant",
      session_id: "s",
      uuid: "a1",
      message: {
        id: "m1",
        model: "claude-opus-4-8",
        role: "assistant",
        content: [{ type: "text", text: "real content arrived" }],
      },
    });
    await flush();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("real content arrived");
    expect(frame).not.toContain("requesting");
    instance.unmount();
  });

  test("hides rate_limit_event by default (meta noise)", async () => {
    const events: ClaudeEvent[] = [
      {
        type: "rate_limit_event",
        session_id: "s",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      },
    ];
    const instance = render(<App initialEvents={events} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("five_hour");
    expect(frame).not.toContain("rate_limit");
    instance.unmount();
  });

  test("hides non-init/status system events (e.g. thinking_tokens) by default", async () => {
    const events = [
      {
        type: "system",
        subtype: "thinking_tokens",
        session_id: "s",
        uuid: "u9",
        thinking_tokens: 1234,
      },
    ] as unknown as ClaudeEvent[];
    const instance = render(<App initialEvents={events} />);
    await flush();
    expect(instance.lastFrame() ?? "").not.toContain("thinking_tokens");
    instance.unmount();
  });

  test("renders an unmodeled top-level event as dim raw rather than dropping", async () => {
    // A wire event the union doesn't model (e.g. compact_boundary / error).
    const events = [
      { type: "compact_boundary", uuid: "cb1", trigger: "auto" },
    ] as unknown as ClaudeEvent[];
    const instance = render(<App initialEvents={events} />);
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("compact_boundary");
    instance.unmount();
  });

  test("renders a parse_error as dim raw", async () => {
    const events: ClaudeEvent[] = [{ type: "parse_error", raw: '{"oops": bad}' }];
    const instance = render(<App initialEvents={events} />);
    await flush();
    expect(instance.lastFrame() ?? "").toContain("oops");
    instance.unmount();
  });
});

describe("<App /> meta-noise filter", () => {
  test("Alt+m reveals the hidden session header", async () => {
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const events: ClaudeEvent[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-xyz",
        uuid: "u1",
        cwd: "/tmp/work",
        model: "claude-opus-4-8",
      },
    ];
    const instance = render(
      <App
        initialEvents={events}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    // Hidden by default.
    expect(instance.lastFrame() ?? "").not.toContain("sess-xyz");

    // Alt+m toggles the meta element → header repaints into view.
    (dispatch as unknown as (i: string, k: Key) => void)("m", { ...baseKey, meta: true });
    await flush();
    expect(instance.lastFrame() ?? "").toContain("sess-xyz");
    instance.unmount();
  });

  test("debug preset shows meta noise (rate_limit, header)", async () => {
    let dispatch: ((input: string, key: Key) => void) | null = null;
    const events: ClaudeEvent[] = [
      {
        type: "rate_limit_event",
        session_id: "s",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      },
    ];
    const instance = render(
      <App
        initialEvents={events}
        testInputBus={(handler) => {
          dispatch = handler;
        }}
      />,
    );
    await flush();
    const send = dispatch as unknown as (i: string, k: Key) => void;
    expect(instance.lastFrame() ?? "").not.toContain("five_hour");

    // normal → verbose → debug (Alt+0 cycles forward).
    send("0", { ...baseKey, meta: true });
    await flush();
    send("0", { ...baseKey, meta: true });
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("preset: debug");
    expect(frame).toContain("five_hour");
    instance.unmount();
  });
});

describe("<App /> token streaming", () => {
  test("shows live text below the transcript, then finalizes on the assistant event", async () => {
    // A manual feed so the test controls when each event arrives.
    let push!: (e: ClaudeEvent) => void;
    let close!: () => void;
    const feed: StreamFeed = (emit) => {
      push = emit.push;
      close = emit.close;
      return () => undefined;
    };
    const instance = render(<App streamFeed={feed} />);
    await flush();

    // Stream message 1's deltas (text idx0 then tool_use idx1).
    for (const ev of streamMsg1) {
      push(ev);
      await flush();
    }
    // The live preview shows the accumulated text before any assistant event.
    expect(instance.lastFrame() ?? "").toContain("Now the file:");

    // The consolidated assistant text event lands → live idx0 is dropped,
    // committed render takes over (still shows the text, exactly once).
    push(assistantMsg1Text);
    await flush();
    const afterText = instance.lastFrame() ?? "";
    expect(afterText.split("Now the file:").length - 1).toBe(1);

    push(assistantMsg1Tool);
    await flush();
    close();
    await flush();
    instance.unmount();
  });

  test("drops the live preview on finalize even when the assistant event has no id (no double render)", async () => {
    let push!: (e: ClaudeEvent) => void;
    const feed: StreamFeed = (emit) => {
      push = emit.push;
      return () => undefined;
    };
    const instance = render(<App streamFeed={feed} />);
    await flush();

    // A message_start with NO id (state.id becomes "") then a text block.
    push({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-8", role: "assistant", content: [] },
      },
      session_id: "s",
      uuid: "ms",
    });
    push({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      session_id: "s",
      uuid: "cbs",
    });
    push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "unique-answer-token" },
      },
      session_id: "s",
      uuid: "cbd",
    });
    await flush();
    // Preview shows the streamed text.
    expect(instance.lastFrame() ?? "").toContain("unique-answer-token");

    // Consolidated assistant event WITHOUT a message.id.
    push({
      type: "assistant",
      session_id: "s",
      uuid: "a",
      message: {
        model: "claude-opus-4-8",
        role: "assistant",
        content: [{ type: "text", text: "unique-answer-token" }],
      },
    });
    await flush();
    const frame = instance.lastFrame() ?? "";
    // Exactly one copy — the lingering preview must not coexist with the
    // committed render.
    expect(frame.split("unique-answer-token").length - 1).toBe(1);
    instance.unmount();
  });

  test("never JSON.parses tool_use partial_json mid-stream (no throw, placeholder shown)", async () => {
    let push!: (e: ClaudeEvent) => void;
    const feed: StreamFeed = (emit) => {
      push = emit.push;
      return () => undefined;
    };
    const instance = render(<App streamFeed={feed} />);
    await flush();
    // Feed only up to a mid-stream (invalid) partial_json for the tool block.
    for (const ev of streamMsg1.slice(0, 7)) {
      push(ev);
      await flush();
    }
    // The Read tool placeholder shows; no parse error thrown (render survived).
    expect(instance.lastFrame() ?? "").toContain("Read");
    instance.unmount();
  });

  test("live preview and committed text both render natively (no markup leak)", async () => {
    let push!: (e: ClaudeEvent) => void;
    const feed: StreamFeed = (emit) => {
      push = emit.push;
      return () => undefined;
    };
    const instance = render(<App streamFeed={feed} />);
    await flush();

    // Stream the text deltas only (no assistant event yet).
    for (const ev of streamMsg1.slice(0, 4)) {
      push(ev);
      await flush();
    }
    // Live preview is rendered through MarkdownRenderer.
    expect(instance.lastFrame() ?? "").toContain("Now the file:");

    // Finalize: the committed text path renders the same content, once.
    push(assistantMsg1Text);
    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Now the file:");
    expect(frame.split("Now the file:").length - 1).toBe(1);
    instance.unmount();
  });
});
