/**
 * Faithful-rendering + token-streaming tests for <App />.
 *
 * Every test here fails against the pre-streaming tree:
 *   - duplicate-answer: result.result re-printed under the final assistant text
 *   - system/init, system/status, rate_limit_event: dropped (returned null)
 *   - unknown top-level event: dropped (final `return null`)
 *   - live streaming preview + finalize-on-assistant: no reducer wired
 *   - glow: never disabled for a live preview (there was no live preview)
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type StreamFeed } from "./App";
import { assistantMsg1Text, assistantMsg1Tool, streamMsg1 } from "./__fixtures__/stream-events";
import type { ClaudeEvent } from "./types/events";

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

  test("renders the system/init session header", async () => {
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
    expect(frame).toContain("sess-xyz");
    expect(frame).toContain("/tmp/work");
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

  test("renders rate_limit_event info instead of dropping it", async () => {
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
    expect(frame).toContain("five_hour");
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

  test("glow is disabled for the live preview and enabled for committed text", async () => {
    const calls: string[] = [];
    const glowSpy = (md: string) => {
      calls.push(md);
      return `[glow]${md}`;
    };
    let push!: (e: ClaudeEvent) => void;
    const feed: StreamFeed = (emit) => {
      push = emit.push;
      return () => undefined;
    };
    const instance = render(<App streamFeed={feed} glow={glowSpy} />);
    await flush();

    // Stream the text deltas only (no assistant event yet).
    for (const ev of streamMsg1.slice(0, 4)) {
      push(ev);
      await flush();
    }
    // Live preview rendered raw — glow must NOT have run on the partial text.
    expect(calls).not.toContain("Hi\n\nNow the file:");
    expect(instance.lastFrame() ?? "").toContain("Now the file:");

    // Finalize: the committed text path DOES run glow.
    push(assistantMsg1Text);
    await flush();
    expect(calls).toContain("Hi\n\nNow the file:");
    instance.unmount();
  });
});
